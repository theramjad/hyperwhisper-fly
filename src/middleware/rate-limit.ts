// IP RATE LIMITING MIDDLEWARE
// Limits anonymous requests to 100/day per IP
// Licensed users bypass IP rate limiting

import type { Context, Next } from 'hono';
import { checkIPRateLimit } from '../lib/redis';

export async function rateLimitMiddleware(c: Context, next: Next) {
  // Skip rate limiting for licensed users (checked in auth middleware)
  const licenseKey = c.req.header('X-License-Key') || c.req.query('license_key');
  if (licenseKey) {
    // Licensed users bypass IP rate limiting
    return next();
  }

  // Get client IP from Fly.io headers
  const clientIP = c.req.header('Fly-Client-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';

  // Check rate limit
  const { allowed, remaining } = await checkIPRateLimit(clientIP);

  // Add rate limit headers
  c.header('X-RateLimit-Limit', '100');
  c.header('X-RateLimit-Remaining', String(remaining));

  if (!allowed) {
    return c.json({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again tomorrow or use a license key.',
      remaining: 0,
    }, 429);
  }

  return next();
}
