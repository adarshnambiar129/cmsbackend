const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const serverless = require('serverless-http');

// Load environment variables
dotenv.config();

const paymentRoutes = require('../routes/paymentRoutes');
const app = express();

// CORS config
app.use(cors({
  origin: process.env.FRONTEND_URL.split(',').map(url => url.trim()), // In case you have multiple origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-VERIFY', 'X-MERCHANT-ID'],
  preflightContinue: false, // Ensures OPTIONS requests are handled properly
  optionsSuccessStatus: 204 // Some legacy browsers (IE11, various SmartTVs) choke on 200
}));

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Routes
app.use('/', paymentRoutes);

app.get('/', (req, res) => {
  res.json({
    message: 'CraftMyStore Payment API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Export as a serverless function
module.exports = app;
module.exports.handler = serverless(app);
