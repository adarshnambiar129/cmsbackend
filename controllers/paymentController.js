const axios = require('axios');
const crypto = require('crypto');
const { StandardCheckoutClient, Env, MetaInfo, StandardCheckoutPayRequest } = require('pg-sdk-node');

// NOTE: In-memory storage is unreliable. We will make the verification stateless.
global.pendingPayments = global.pendingPayments || {};

// PhonePe Payment Initiation using SDK
exports.initiatePhonePePayment = async (req, res) => {
  try {
    const { amount, ecommPlan, hostingPlan, customerName, customerEmail, customerPhone } = req.body;

    console.log('PhonePe Payment Request:', req.body);

    // Validation
    if (!amount || !customerPhone || !customerEmail || !customerName) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    if (!/^\d{10}$/.test(customerPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format' });
    }
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // Generate unique transaction ID
    const merchantTransactionId = `CMS_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // PhonePe production or sandbox environment based on .env
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');

    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;

    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);

    // Construct the pay request
    const payRequest = new StandardCheckoutPayRequest();
    payRequest.merchantId = clientId;
    payRequest.merchantTransactionId = merchantTransactionId;
    payRequest.amount = Math.round(amount * 100); // Amount in paise
    payRequest.merchantUserId = customerEmail.substring(0, 34);
    
    // CRITICAL CHANGE: Pass all necessary info in the callback URL
    const frontendCallbackUrl = `${process.env.FRONTEND_URL}/payment-status?merchantTransactionId=${merchantTransactionId}&amount=${amount}&method=phonepe&customer=${encodeURIComponent(customerName)}`;
    payRequest.callbackUrl = frontendCallbackUrl;
    payRequest.redirectUrl = frontendCallbackUrl;
    payRequest.redirectMode = 'POST';

    // Set mobile number
    payRequest.mobileNumber = customerPhone;

    // Make the pay request
    const payResponse = await client.pay(payRequest);
    console.log('PhonePe Pay Response:', payResponse);

    // The SDK handles the redirect URL generation
    const redirectUrl = payResponse.instrumentResponse.redirectInfo.url;

    // Store the PhonePe Order ID with the transaction ID for verification
    global.pendingPayments[merchantTransactionId] = {
        phonepeOrderId: payResponse.merchantOrderId,
        status: 'INITIATED'
    };

    res.json({
      success: true,
      redirectUrl: redirectUrl,
      merchantTransactionId: merchantTransactionId
    });

  } catch (error) {
    console.error('PhonePe Initiation Error:', error);
    res.status(500).json({
      success: false,
      message: 'Payment initiation failed: ' + error.message
    });
  }
};

// PhonePe Callback Handler
exports.phonePeCallback = async (req, res) => {
  try {
    console.log('Received PhonePe callback:', req.body);
    // This is where you would handle server-to-server callbacks if configured.
    // For now, we rely on the frontend verification.
    res.status(200).send('Callback received');
  } catch (error) {
    console.error('Callback Error:', error);
    res.status(500).send('Error processing callback');
  }
};

// Verify PhonePe Payment using SDK
exports.verifyPhonePePayment = async (req, res) => {
  try {
    const { merchantTransactionId } = req.params;

    if (!merchantTransactionId) {
      return res.status(400).json({ success: false, message: 'Missing transaction ID' });
    }

    console.log('Verifying PhonePe payment for:', merchantTransactionId);

    // Get stored payment info
    if (!global.pendingPayments || !global.pendingPayments[merchantTransactionId]) {
      // This is now less likely to be the primary failure point, but good to have.
      return res.status(404).json({ success: false, status: 'FAILED', message: 'Transaction not found or server restarted. Please contact support.' });
    }

    const paymentInfo = global.pendingPayments[merchantTransactionId];
    const phonepeOrderId = paymentInfo.phonepeOrderId;

    if (!phonepeOrderId) {
      return res.status(400).json({ success: false, status: 'FAILED', message: 'PhonePe order ID not found for this transaction' });
    }

    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;
    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);

    // Check payment status
    const statusResponse = await client.checkStatus(phonepeOrderId);
    console.log('PhonePe Status Response:', JSON.stringify(statusResponse, null, 2));

    // Determine the final status
    if (statusResponse && (statusResponse.code === 'PAYMENT_SUCCESS' || statusResponse.state === 'COMPLETED')) {
      return res.json({ success: true, status: 'SUCCESS', message: 'Payment successful' });
    } else if (statusResponse && (statusResponse.state === 'PENDING' || statusResponse.state === 'INITIATED')) {
      return res.json({ success: false, status: 'PENDING', message: 'Payment is still processing' });
    } else {
      return res.json({ success: false, status: 'FAILED', message: 'Payment failed or was cancelled' });
    }

  } catch (error) {
    console.error('PhonePe Verification Error:', error);
    return res.status(500).json({ success: false, status: 'FAILED', message: 'Verification failed due to a server error: ' + error.message });
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
