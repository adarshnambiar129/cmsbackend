const axios = require('axios');
const crypto = require('crypto');
const { StandardCheckoutClient, Env, MetaInfo, StandardCheckoutPayRequest } = require('pg-sdk-node');

// Store pending payments in memory (use database in production)
global.pendingPayments = global.pendingPayments || {};

// PhonePe Payment Initiation using SDK
exports.initiatePhonePePayment = async (req, res) => {
  try {
    const { amount, ecommPlan, hostingPlan, customerName, customerEmail, customerPhone } = req.body;
    
    console.log('PhonePe Payment Request:', req.body);
    
    // Validation
    if (!amount || !customerPhone || !customerEmail || !customerName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: amount, customerPhone, customerEmail, customerName'
      });
    }
    
    // Validate phone number format
    if (!/^\d{10}$/.test(customerPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number must be exactly 10 digits'
      });
    }

    // Validate amount
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }
    
    // Generate unique transaction ID
    const merchantTransactionId = `CMS_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    
    // Store payment info for verification
    const paymentInfo = {
      merchantTransactionId,
      amount: parseFloat(amount),
      customerName,
      customerEmail,
      customerPhone,
      ecommPlan,
      hostingPlan,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };
    
    global.pendingPayments[merchantTransactionId] = paymentInfo;

    // PhonePe production or sandbox environment based on .env
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');
    
    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;

    console.log(`Using PhonePe ${isProduction ? 'PRODUCTION' : 'SANDBOX'} environment`);

    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);
    
    // Prepare redirectUrl with transaction details
    const redirectUrl = `${process.env.FRONTEND_URL}/payment-status?merchantTransactionId=${merchantTransactionId}&amount=${amount}&method=phonepe&customer=${encodeURIComponent(customerName)}`;
    
    // Build metadata
    const metaInfo = MetaInfo.builder()
      .udf1(customerEmail)
      .udf2(customerPhone)
      .udf3(ecommPlan || hostingPlan || '')
      .build();
    
    // Create payment request using the SDK
    const request = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantTransactionId)
      .amount(Math.round(parseFloat(amount) * 100)) // Convert to paise
      .redirectUrl(redirectUrl)
      .metaInfo(metaInfo)
      .build();
    
    console.log('PhonePe SDK Request:', request);
    
    // Make the payment request
    const response = await client.pay(request);
    console.log('PhonePe SDK Response:', response);
    
    if (response && response.redirectUrl) {
      // Update payment info with order ID and redirect URL
      global.pendingPayments[merchantTransactionId].phonepeOrderId = response.orderId;
      global.pendingPayments[merchantTransactionId].redirectUrl = response.redirectUrl;
      global.pendingPayments[merchantTransactionId].status = 'INITIATED';
      global.pendingPayments[merchantTransactionId].expireAt = response.expireAt;
      
      return res.json({
        success: true,
        redirectUrl: response.redirectUrl,
        merchantTransactionId,
        orderId: response.orderId,
        message: 'Payment initiated successfully'
      });
    } else {
      console.error('PhonePe SDK Error: Missing redirect URL');
      return res.status(400).json({
        success: false,
        message: 'Payment initiation failed - missing redirect URL',
        error: response
      });
    }
    
  } catch (error) {
    console.error('PhonePe Payment Error:', error);
    
    return res.status(500).json({
      success: false,
      message: error.message || 'Payment initiation failed',
      error: error
    });
  }
};

// PhonePe Callback Handler
exports.phonePeCallback = async (req, res) => {
  try {
    console.log('PhonePe Callback received:', {
      body: req.body,
      query: req.query,
      headers: req.headers
    });
    
    const { merchantTransactionId, status } = req.query;
    
    if (merchantTransactionId && global.pendingPayments[merchantTransactionId]) {
      global.pendingPayments[merchantTransactionId].status = status || 'COMPLETED';
      global.pendingPayments[merchantTransactionId].updatedAt = new Date().toISOString();
      console.log('Updated payment status for:', merchantTransactionId, 'to:', status);
    }
    
    res.status(200).json({ success: true, message: 'Callback processed' });
  } catch (error) {
    console.error('PhonePe Callback Error:', error);
    res.status(500).json({ success: false, message: 'Callback failed' });
  }
};

// Verify PhonePe Payment using SDK - IMPROVED to correctly handle cancelled payments
exports.verifyPhonePePayment = async (req, res) => {
  try {
    const { merchantTransactionId } = req.params;
    
    if (!merchantTransactionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing transaction ID'
      });
    }

    console.log('Verifying PhonePe payment for:', merchantTransactionId);
    
    // Get stored payment info
    if (!global.pendingPayments || !global.pendingPayments[merchantTransactionId]) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }
    
    const paymentInfo = global.pendingPayments[merchantTransactionId];
    const phonepeOrderId = paymentInfo.phonepeOrderId;
    
    if (!phonepeOrderId) {
      return res.status(400).json({
        success: false,
        message: 'PhonePe order ID not found for this transaction',
        status: 'PAYMENT_ERROR'
      });
    }
    
    // PhonePe production or sandbox environment based on .env
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');
    
    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;

    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);
    
    // Check payment status using the SDK
    const statusResponse = await client.checkStatus(phonepeOrderId);
    console.log('PhonePe Status Response:', statusResponse);
    
    // Update payment status
    global.pendingPayments[merchantTransactionId].status = statusResponse.state;
    global.pendingPayments[merchantTransactionId].verifiedAt = new Date().toISOString();
    global.pendingPayments[merchantTransactionId].paymentDetails = statusResponse;
    
    // Check for specific success conditions
    const isSuccess = 
      statusResponse && 
      (statusResponse.code === 'PAYMENT_SUCCESS' || 
       statusResponse.state === 'COMPLETED' || 
       statusResponse.state === 'SUCCESS');
    
    return res.json({
      success: true,
      data: {
        ...statusResponse,
        isPaymentSuccessful: isSuccess,
        responseCode: isSuccess ? 'SUCCESS' : 'FAILED',
        code: isSuccess ? 'PAYMENT_SUCCESS' : 'PAYMENT_ERROR'
      }
    });
    
  } catch (error) {
    console.error('PhonePe Verification Error:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Verification failed: ' + error.message,
      error: error,
      data: {
        isPaymentSuccessful: false,
        responseCode: 'FAILED',
        code: 'PAYMENT_ERROR'
      }
    });
  }
};

// PayPal Payment Initiation - FIXED variable name
exports.initiatePayPalPayment = async (req, res) => {
  try {
    const { amount, customerName, customerEmail, customerPhone, ecommPlan, hostingPlan } = req.body;

    if (!amount || !customerEmail) {
      return res.status(400).json({
        success: false,
        message: 'Amount and customer email are required'
      });
    }

    // Get PayPal access token - FIXED variable name to match .env
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET_KEY}`).toString('base64');
    
    console.log('PayPal Auth:', `${process.env.PAYPAL_CLIENT_ID}:***`);
    console.log('PayPal URL:', `${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`);
    
    const tokenResponse = await axios.post(`${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`, 
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;
    console.log('PayPal Access Token Obtained');

    // Create order
    const orderResponse = await axios.post(`${process.env.PAYPAL_BASE_URL}/v2/checkout/orders`, {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: amount.toString()
        },
        description: `CraftMyStore Plan: ${ecommPlan || hostingPlan || 'Custom'}`
      }],
      application_context: {
        return_url: `${process.env.FRONTEND_URL}/payment-success?method=paypal&amount=${amount}&customer=${encodeURIComponent(customerName || customerEmail)}`,
        cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
        brand_name: 'CraftMyStore',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('PayPal Order Created:', orderResponse.data.id);
    const approvalUrl = orderResponse.data.links.find(link => link.rel === 'approve').href;

    res.json({
      success: true,
      orderId: orderResponse.data.id,
      approvalUrl: approvalUrl
    });

  } catch (error) {
    console.error('PayPal Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'PayPal payment initiation failed',
      error: error.response?.data || error.message
    });
  }
};

// PayPal Payment Capture - FIXED variable name
exports.capturePayPalPayment = async (req, res) => {
  try {
    const { orderID } = req.body;

    if (!orderID) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required'
      });
    }

    console.log('Capturing PayPal payment for order:', orderID);

    // Get PayPal access token - FIXED variable name to match .env
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET_KEY}`).toString('base64');
    
    const tokenResponse = await axios.post(`${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`, 
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Capture payment
    const captureResponse = await axios.post(`${process.env.PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`, {}, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('PayPal Capture Successful for order:', orderID);
    res.json({
      success: true,
      data: captureResponse.data
    });

  } catch (error) {
    console.error('PayPal Capture Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'PayPal payment capture failed',
      error: error.response?.data || error.message
    });
  }
};
