const axios = require('axios');
const crypto = require('crypto');

exports.initiatePhonePePayment = async (req, res) => {
  try {
    const { amount, ecommPlan, hostingPlan, customerName, customerEmail, customerPhone } = req.body;
    
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
    
    // Store in global object (in production, use database)
    global.pendingPayments = global.pendingPayments || {};
    global.pendingPayments[merchantTransactionId] = paymentInfo;

    // PhonePe API payload
    const payload = {
      merchantId: process.env.PHONEPE_MERCHANT_ID,
      merchantTransactionId: merchantTransactionId,
      merchantUserId: `MUID_${Date.now()}`,
      amount: Math.round(parseFloat(amount) * 100), // Convert to paise
      redirectUrl: `${process.env.FRONTEND_URL}/payment-status?merchantTransactionId=${merchantTransactionId}&status=success&amount=${amount}&method=phonepe&customer=${encodeURIComponent(customerName)}`,
      redirectMode: "REDIRECT",
      callbackUrl: `${process.env.FRONTEND_URL}/api/payment/phonepe-callback`,
      mobileNumber: customerPhone,
      paymentInstrument: {
        type: "PAY_PAGE"
      }
    };
    
    console.log('PhonePe Payload:', JSON.stringify(payload, null, 2));
    
    // Create base64 encoded payload
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    console.log('Base64 Payload:', payloadBase64);
    
    // Create checksum
    const apiEndpoint = "/pg/v1/pay";
    const checksumString = payloadBase64 + apiEndpoint + process.env.PHONEPE_MERCHANT_KEY;
    const sha256Hash = crypto.createHash('sha256').update(checksumString).digest('hex');
    const xVerifyHeader = sha256Hash + "###" + process.env.PHONEPE_SALT_INDEX;
    
    console.log('X-VERIFY Header:', xVerifyHeader);
    
    // Make API call to PhonePe
    const apiUrl = `${process.env.PHONEPE_BASE_URL}/pg/v1/pay`;
    console.log('API URL:', apiUrl);
    
    const response = await axios.post(
      apiUrl,
      { request: payloadBase64 },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerifyHeader,
          'accept': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );
    
    console.log('PhonePe API Response:', JSON.stringify(response.data, null, 2));
    
    // Check response
    if (response.data && response.data.success === true) {
      const redirectUrl = response.data.data.instrumentResponse.redirectInfo.url;
      
      // Update payment info with redirect URL
      global.pendingPayments[merchantTransactionId].redirectUrl = redirectUrl;
      global.pendingPayments[merchantTransactionId].status = 'INITIATED';
      
      return res.json({
        success: true,
        redirectUrl,
        merchantTransactionId,
        message: 'Payment initiated successfully'
      });
    } else {
      console.error('PhonePe API Error Response:', response.data);
      return res.status(400).json({
        success: false,
        message: response.data?.message || 'Payment initiation failed',
        error: response.data
      });
    }
    
  } catch (error) {
    console.error('PhonePe Payment Error:', error);
    
    // Detailed error logging
    if (error.response) {
      console.error('Error Response Status:', error.response.status);
      console.error('Error Response Data:', error.response.data);
      console.error('Error Response Headers:', error.response.headers);
      
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data?.message || 'PhonePe API error',
        error: error.response.data
      });
    } else if (error.request) {
      console.error('Error Request:', error.request);
      return res.status(500).json({
        success: false,
        message: 'No response from PhonePe API',
        error: 'Network error'
      });
    } else {
      console.error('Error Message:', error.message);
      return res.status(500).json({
        success: false,
        message: error.message || 'Payment initiation failed',
        error: 'Server error'
      });
    }
  }
};

// PhonePe Callback Handler
exports.phonePeCallback = async (req, res) => {
  try {
    console.log('PhonePe Callback received:', req.body, req.query);
    
    const { merchantTransactionId, status } = req.query;
    
    if (merchantTransactionId && global.pendingPayments && global.pendingPayments[merchantTransactionId]) {
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

// Verify PhonePe Payment - Production Only
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
    
    // Create verification checksum
    const statusEndpoint = `/pg/v1/status/${process.env.PHONEPE_MERCHANT_ID}/${merchantTransactionId}`;
    const checksumString = statusEndpoint + process.env.PHONEPE_MERCHANT_KEY;
    const sha256Hash = crypto.createHash('sha256').update(checksumString).digest('hex');
    const xVerifyHeader = sha256Hash + "###" + process.env.PHONEPE_SALT_INDEX;
    
    const statusUrl = `${process.env.PHONEPE_BASE_URL}${statusEndpoint}`;
    console.log('Verification URL:', statusUrl);
    console.log('X-VERIFY Header:', xVerifyHeader);
    
    // Make verification API call
    const response = await axios.get(statusUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerifyHeader,
        'X-MERCHANT-ID': process.env.PHONEPE_MERCHANT_ID,
        'accept': 'application/json'
      },
      timeout: 30000
    });
    
    console.log('PhonePe Verification Response:', JSON.stringify(response.data, null, 2));
    
    if (response.data && response.data.success) {
      // Update local payment status
      if (global.pendingPayments && global.pendingPayments[merchantTransactionId]) {
        global.pendingPayments[merchantTransactionId].status = response.data.data.state;
        global.pendingPayments[merchantTransactionId].verifiedAt = new Date().toISOString();
      }
      
      return res.json({
        success: true,
        data: response.data.data
      });
    } else {
      console.error('PhonePe Verification Failed:', response.data);
      return res.status(400).json({
        success: false,
        message: response.data?.message || 'Payment verification failed',
        data: response.data
      });
    }
    
  } catch (error) {
    console.error('PhonePe Verification Error:', error);
    
    if (error.response) {
      console.error('Verification Error Response:', error.response.data);
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data?.message || 'Verification API error',
        error: error.response.data
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Verification failed',
        error: error.message
      });
    }
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
        cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`
      }
    };
    
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
    
    const approvalUrl = orderResponse.data.links.find(link => link.rel === 'approve').href;
    
    res.json({
      success: true,
      orderId: orderResponse.data.id,
      redirectUrl: approvalUrl
    });
    
  } catch (error) {
    console.error('PayPal Error:', error);
    res.status(500).json({
      success: false,
      message: 'PayPal payment failed: ' + error.message
    });
  }
};

// Capture PayPal Payment
exports.capturePayPalPayment = async (req, res) => {
  try {
    const { orderID } = req.body;
    
    if (!orderID) {
      return res.status(400).json({
        success: false,
        message: 'Missing order ID'
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
    
    res.json({
      success: true,
      data: captureResponse.data
    });
    
  } catch (error) {
    console.error('PayPal Capture Error:', error);
    res.status(500).json({
      success: false,
      message: 'Capture failed: ' + error.message
    });
  }
};
