/**
 * Homer Azure Proxy
 *
 * This proxy runs on Azure Container Apps and routes requests to the
 * Cloudflare tunnel endpoints, hiding personal domains from corporate networks.
 *
 * Routes:
 *   /api/*  -> homer.jiangyanqing.com/api/*  (Homer API)
 *   /guac/* -> guac.jiangyanqing.com/*       (Guacamole remote desktop)
 *
 * Why this exists:
 *   - Corporate firewall only sees Azure domains (*.azurecontainerapps.io)
 *   - Personal domain (jiangyanqing.com) is called FROM Azure, not from work laptop
 *   - All traffic appears as Azure-to-Azure to corporate DPI
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

// Target URLs - configure via environment variables for flexibility
const HOMER_API_URL = process.env.HOMER_API_URL || 'https://homer.jiangyanqing.com';
const GUACAMOLE_URL = process.env.GUACAMOLE_URL || 'https://guac.jiangyanqing.com';

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

// Proxy configuration for Guacamole
// This needs WebSocket support for the remote desktop connection
const guacProxy = createProxyMiddleware({
  target: GUACAMOLE_URL,
  changeOrigin: true,
  ws: true,  // Enable WebSocket proxying
  pathRewrite: {
    '^/guac': ''  // Remove /guac prefix when forwarding
  },
  onProxyReq: (proxyReq, req, res) => {
    // Forward cookies for Guacamole session
    if (req.headers.cookie) {
      proxyReq.setHeader('Cookie', req.headers.cookie);
    }
  },
  onProxyReqWs: (proxyReq, req, socket, options, head) => {
    // WebSocket upgrade handling for Guacamole tunnel
    console.log('WebSocket upgrade request:', req.url);
  },
  onError: (err, req, res) => {
    console.error('Guacamole Proxy error:', err.message);
    if (res.writeHead) {
      res.status(502).json({ error: 'Proxy error', message: err.message });
    }
  }
});

// Mount proxies
app.use('/api', apiProxy);
app.use('/guac', guacProxy);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Homer Azure Proxy',
    version: '1.0.0',
    routes: {
      '/api/*': 'Homer API proxy',
      '/guac/*': 'Guacamole remote desktop proxy',
      '/health': 'Health check'
    }
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Homer Azure Proxy listening on port ${PORT}`);
  console.log(`  API proxy:  /api/* -> ${HOMER_API_URL}`);
  console.log(`  Guac proxy: /guac/* -> ${GUACAMOLE_URL}`);
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/guac')) {
    guacProxy.upgrade(req, socket, head);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
