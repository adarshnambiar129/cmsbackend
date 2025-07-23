const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// PhonePe Routes
router.post('/initiate-phonepe', paymentController.initiatePhonePePayment);
router.post('/phonepe-callback', paymentController.phonePeCallback);
router.get('/verify-phonepe/:merchantTransactionId', paymentController.verifyPhonePePayment);

// PayPal Routes
router.post('/initiate-paypal', paymentController.initiatePayPalPayment);
router.post('/capture-paypal', paymentController.capturePayPalPayment);

// Health check route
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Payment API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production'
  });
});

module.exports = router;