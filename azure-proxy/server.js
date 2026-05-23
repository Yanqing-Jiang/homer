/**
 * Homer Azure Proxy
 *
 * This proxy runs on Azure Container Apps and routes requests to the
 * Cloudflare tunnel endpoints, hiding the origin domain from restrictive networks.
 *
 * Routes:
 *   /api/*      -> $HOMER_API_URL/api/*    (Homer API)
 *   /supabase/* -> $SUPABASE_URL/*         (Supabase auth)
 *
 * Why this exists:
 *   - The proxy fronts only Azure domains (*.azurecontainerapps.io)
 *   - The origin domain is called FROM Azure, never directly from the client
 *   - All client traffic appears as Azure-to-Azure
 *
 * Configure HOMER_API_URL and SUPABASE_URL via environment variables.
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

// Target URLs — REQUIRED. No defaults so a misconfigured deploy fails loud.
const HOMER_API_URL = process.env.HOMER_API_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
if (!HOMER_API_URL || !SUPABASE_URL) {
  console.error('FATAL: HOMER_API_URL and SUPABASE_URL must be set.');
  process.exit(1);
}

// Enable CORS for Azure Static Web Apps and Blob Storage
app.use(cors({
  origin: [
    /\.azurestaticapps\.net$/,
    /\.web\.core\.windows\.net$/,  // Azure Blob Storage static websites
    /localhost/,
    /127\.0\.0\.1/
  ],
  credentials: true
}));

// Health check endpoint for Azure Container Apps
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Proxy configuration for Homer API
const apiProxy = createProxyMiddleware({
  target: HOMER_API_URL,
  changeOrigin: true,
  pathRewrite: {
    '^/api': '/api'  // Keep /api prefix
  },
  onProxyReq: (proxyReq, req, res) => {
    // Forward auth headers
    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }
  },
  onError: (err, req, res) => {
    console.error('API Proxy error:', err.message);
    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
});

// Proxy configuration for Supabase Auth
// Hides supabase.co domain from corporate network DPI
const supabaseProxy = createProxyMiddleware({
  target: SUPABASE_URL,
  changeOrigin: true,
  pathRewrite: {
    '^/supabase': ''  // Remove /supabase prefix: /supabase/auth/v1/... -> /auth/v1/...
  },
  onProxyReq: (proxyReq, req, res) => {
    // Forward auth and apikey headers (required by Supabase)
    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }
    if (req.headers.apikey) {
      proxyReq.setHeader('apikey', req.headers.apikey);
    }
  },
  onError: (err, req, res) => {
    console.error('Supabase Proxy error:', err.message);
    res.status(502).json({ error: 'Proxy error', message: err.message });
  }
});

// Mount proxies
app.use('/api', apiProxy);
app.use('/supabase', supabaseProxy);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Homer Azure Proxy',
    version: '1.1.0',
    routes: {
      '/api/*': 'Homer API proxy',
      '/supabase/*': 'Supabase auth proxy',
      '/health': 'Health check'
    }
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Homer Azure Proxy listening on port ${PORT}`);
  console.log(`  API proxy:      /api/*      -> ${HOMER_API_URL}`);
  console.log(`  Supabase proxy: /supabase/* -> ${SUPABASE_URL}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
