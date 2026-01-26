// HYPERWHISPER FLY.IO TRANSCRIPTION SERVICE
// Edge-based transcription proxy replacing Cloudflare Workers
// Eliminates R2 upload path complexity - can buffer larger audio files in memory

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { transcribeRoute } from './routes/transcribe';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rate-limit';

const app = new Hono();

// CORS - allow requests from HyperWhisper clients
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'X-STT-Provider', 'X-Device-ID', 'X-License-Key'],
}));

// Health check endpoint - Fly.io uses this for health monitoring
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    region: process.env.FLY_REGION || 'local',
    timestamp: new Date().toISOString(),
  });
});

// Main transcription endpoint
// Middleware order: rate-limit → auth → transcribe
app.post('/transcribe',
  rateLimitMiddleware,
  authMiddleware,
  transcribeRoute
);

// 404 fallback
app.notFound((c) => {
  return c.json({
    error: 'Not found',
    hint: 'Valid endpoints: POST /transcribe, GET /health',
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({
    error: 'Internal server error',
    message: err.message,
  }, 500);
});

// Export for Bun
export default {
  port: Number(process.env.PORT) || 8080,
  fetch: app.fetch,
};

console.log(`HyperWhisper Fly.io service starting on port ${process.env.PORT || 8080}`);
console.log(`Region: ${process.env.FLY_REGION || 'local'}`);
