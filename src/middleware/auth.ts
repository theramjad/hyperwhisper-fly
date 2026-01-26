// AUTHENTICATION MIDDLEWARE
// Validates license keys via Next.js API and manages device credits for trial users

import type { Context, Next } from 'hono';
import { getDeviceCredits, getCachedLicense, cacheLicense, type CachedLicense } from '../lib/redis';

// Auth context stored on the request
export interface AuthContext {
  type: 'licensed' | 'trial';
  identifier: string; // license_key or device_id
  credits?: number;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// Validate license against Next.js API
async function validateLicense(licenseKey: string): Promise<CachedLicense> {
  const apiUrl = process.env.NEXTJS_LICENSE_API_URL || 'https://hyperwhisper.com/api/license/validate';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.POLAR_API_KEY || ''}`,
      },
      body: JSON.stringify({ license_key: licenseKey }),
    });

    if (!response.ok) {
      return {
        valid: false,
        cachedAt: new Date().toISOString(),
      };
    }

    const data = await response.json() as { valid: boolean; credits?: number; expiresAt?: string };

    return {
      valid: data.valid,
      credits: data.credits,
      expiresAt: data.expiresAt,
      cachedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('License validation failed:', error);
    return {
      valid: false,
      cachedAt: new Date().toISOString(),
    };
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const licenseKey = c.req.header('X-License-Key') || c.req.query('license_key');
  const deviceId = c.req.header('X-Device-ID') || c.req.query('device_id');

  // Licensed user flow
  if (licenseKey) {
    // Check cache first
    let license = await getCachedLicense(licenseKey);

    if (!license) {
      // Validate against API
      license = await validateLicense(licenseKey);
      // Cache the result
      await cacheLicense(licenseKey, license);
    }

    if (!license.valid) {
      return c.json({
        error: 'Invalid license',
        message: 'License key is invalid or expired.',
      }, 401);
    }

    c.set('auth', {
      type: 'licensed',
      identifier: licenseKey,
      credits: license.credits,
    });

    return next();
  }

  // Trial user flow (device_id)
  if (deviceId) {
    const credits = await getDeviceCredits(deviceId);

    if (credits <= 0) {
      return c.json({
        error: 'Insufficient credits',
        message: 'Trial credits exhausted. Please purchase a license.',
        credits: 0,
      }, 402);
    }

    c.set('auth', {
      type: 'trial',
      identifier: deviceId,
      credits,
    });

    return next();
  }

  // No authentication provided
  return c.json({
    error: 'Authentication required',
    message: 'Provide X-License-Key header or device_id query parameter.',
  }, 401);
}
