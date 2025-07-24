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
    // const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;
    const env = Env.SANDBOX;

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

// Verify PhonePe Payment using SDK
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

    // PhonePe production or sandbox environment based on .env
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');

    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;

    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);

    console.log('Checking payment status using merchantTransactionId:', merchantTransactionId);
    
    // Use getOrderStatus as per PhonePe documentation instead of checkStatus
    const statusResponse = await client.getOrderStatus(merchantTransactionId);
    console.log('PhonePe Status Response:', JSON.stringify(statusResponse, null, 2));

    // Update payment status in memory
    global.pendingPayments[merchantTransactionId].status = statusResponse?.state || 'UNKNOWN';
    global.pendingPayments[merchantTransactionId].verifiedAt = new Date().toISOString();
    global.pendingPayments[merchantTransactionId].paymentDetails = statusResponse;

    // Determine the final status to send to the frontend based on PhonePe state
    if (statusResponse && statusResponse.state === 'COMPLETED') {
      console.log('SUCCESS DETECTED - Payment verified as successful');
      
      // Also check payment details if available
      const paymentDetail = statusResponse.paymentDetails && 
                           statusResponse.paymentDetails.length > 0 ? 
                           statusResponse.paymentDetails[0] : null;
      
      if (paymentDetail && paymentDetail.state !== 'COMPLETED') {
        console.log('WARNING: Order state is COMPLETED but payment detail state is', paymentDetail.state);
      }
      
      return res.json({
        success: true,
        status: 'SUCCESS',
        message: 'Payment successful',
        data: statusResponse
      });
    } else if (statusResponse && statusResponse.state === 'PENDING') {
      console.log('PENDING DETECTED - Payment is still processing');
      return res.json({
        success: false,
        status: 'PENDING',
        message: 'Payment is still processing',
        data: statusResponse
      });
    } else {
      console.log('FAILURE DETECTED - Payment verified as failed or cancelled');
      
      // Extract error information if available
      const paymentDetail = statusResponse.paymentDetails && 
                           statusResponse.paymentDetails.length > 0 ? 
                           statusResponse.paymentDetails[0] : null;
      
      const errorInfo = paymentDetail ? 
                        `Error: ${paymentDetail.errorCode || 'Unknown'} - ${paymentDetail.detailedErrorCode || ''}` : 
                        'No detailed error information available';
      
      return res.json({
        success: false,
        status: 'FAILED',
        message: `Payment failed or was cancelled. ${errorInfo}`,
        data: statusResponse
      });
    }

  } catch (error) {
    console.error('PhonePe Verification Error:', error);
    return res.status(500).json({
      success: false,
      status: 'FAILED',
      message: 'Verification failed due to a server error: ' + error.message
    });
  }
};

// PayPal Payment Initiation
exports.initiatePayPalPayment = async (req, res) => {
  try {
    const { amount, ecommPlan, hostingPlan, customerName, customerEmail } = req.body;
    
    if (!amount || !customerEmail || !customerName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }
    
    // Get PayPal access token
    const tokenResponse = await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET_KEY}`).toString('base64')}`
        }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    
    // Create PayPal order
    const orderData = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: amount.toString()
        },
        description: `CraftMyStore - ${ecommPlan} + ${hostingPlan}`
      }],
      application_context: {
        return_url: `${process.env.FRONTEND_URL}/payment-success`,
        cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
        brand_name: 'CraftMyStore',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW'
      }
    };
    
    console.log('PayPal order data:', JSON.stringify(orderData, null, 2));
    
    const orderResponse = await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v2/checkout/orders`,
      orderData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    console.log('PayPal order created:', orderResponse.data.id);
    const approvalUrl = orderResponse.data.links.find(link => link.rel === 'approve').href;
    console.log('PayPal approval URL:', approvalUrl);
    
    // FIXED: Changed approvalUrl to redirectUrl to match frontend expectations
    res.json({
      success: true,
      orderId: orderResponse.data.id,
      redirectUrl: approvalUrl
    });
    
  } catch (error) {
    console.error('PayPal Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'PayPal payment failed: ' + (error.response?.data?.message || error.message)
    });
  }
};

// Capture PayPal Payment - No changes needed
exports.capturePayPalPayment = async (req, res) => {
  try {
    const { orderID } = req.body;
    
    if (!orderID) {
      return res.status(400).json({
        success: false,
        message: 'Missing order ID'
      });
    }
    
    console.log('Capturing PayPal payment for order:', orderID);
    
    // Get PayPal access token
    const tokenResponse = await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET_KEY}`).toString('base64')}`
        }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    
    // Capture payment
    const captureResponse = await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    console.log('PayPal payment captured successfully');
    
    res.json({
      success: true,
      data: captureResponse.data
    });
    
  } catch (error) {
    console.error('PayPal Capture Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Capture failed: ' + (error.response?.data?.message || error.message)
    });
  }
};
