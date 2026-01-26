// HYPERWHISPER FLY.IO TRANSCRIPTION SERVICE
// Edge-based transcription proxy replacing Cloudflare Workers
// Eliminates R2 upload path complexity - can buffer larger audio files in memory

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { websocket } from 'hono/bun';
import { transcribeRoute } from './routes/transcribe';
import { postProcessRoute } from './routes/post-process';
import { usageRoute } from './routes/usage';
import { wsStreamingPreflight, wsStreamingRoute } from './routes/ws-streaming-deepgram';

const app = new Hono();

// CORS - align with Cloudflare (Content-Type only)
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
}));

app.options('*', (c) => c.body(null, 204));

// Health check endpoint - Fly.io uses this for health monitoring
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    region: process.env.FLY_REGION || 'local',
    timestamp: new Date().toISOString(),
  });
});

// Main transcription endpoint
app.post('/transcribe', transcribeRoute);

// Standalone post-processing endpoint
app.post('/post-process', postProcessRoute);

// Usage endpoint
app.get('/usage', usageRoute);

// WebSocket streaming endpoint
app.get('/ws/streaming-deepgram', wsStreamingPreflight, wsStreamingRoute);

// Fallback - match Cloudflare (405, plain text)
app.notFound((c) => {
  return c.text('Method not allowed', 405);
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
  websocket,
};

console.log(`HyperWhisper Fly.io service starting on port ${process.env.PORT || 8080}`);
console.log(`Region: ${process.env.FLY_REGION || 'local'}`);
