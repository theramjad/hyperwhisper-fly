// UPSTASH REDIS CLIENT
// Serverless Redis for rate limiting, device credits, and license caching
// Works globally with Fly.io's anycast routing

import { Redis } from '@upstash/redis';

// Initialize Redis client (lazy initialization for testing without Redis)
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_URL;
    const token = process.env.UPSTASH_REDIS_TOKEN;

    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN are required');
    }

    _redis = new Redis({ url, token });
  }
  return _redis;
}

// Export redis getter for lazy initialization
export const redis = {
  get: getRedis,
};

// ============================================================================
// DEVICE CREDITS
// Trial users get 150 credits (~24 minutes of transcription)
// ============================================================================

const DEFAULT_CREDITS = 150;

export async function getDeviceCredits(deviceId: string): Promise<number> {
  try {
    const credits = await getRedis().get<number>(`device_credits:${deviceId}`);
    return credits ?? DEFAULT_CREDITS;
  } catch (error) {
    console.error('Failed to get device credits:', error);
    return DEFAULT_CREDITS; // Fail open for better UX
  }
}

export async function deductDeviceCredits(deviceId: string, amount: number): Promise<number> {
  try {
    const newBalance = await getRedis().incrbyfloat(`device_credits:${deviceId}`, -amount);
    return newBalance;
  } catch (error) {
    console.error('Failed to deduct device credits:', error);
    throw error;
  }
}

export async function setDeviceCredits(deviceId: string, amount: number): Promise<void> {
  try {
    await getRedis().set(`device_credits:${deviceId}`, amount);
  } catch (error) {
    console.error('Failed to set device credits:', error);
    throw error;
  }
}

// ============================================================================
// IP RATE LIMITING
// Anonymous users limited to 100 requests per day per IP
// ============================================================================

const IP_DAILY_LIMIT = 100;
const SECONDS_IN_DAY = 86400;

export async function checkIPRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const key = `ip_daily:${ip}:${today}`;

    const count = await getRedis().incr(key);

    // Set expiry on first access
    if (count === 1) {
      await getRedis().expire(key, SECONDS_IN_DAY);
    }

    return {
      allowed: count <= IP_DAILY_LIMIT,
      remaining: Math.max(0, IP_DAILY_LIMIT - count),
    };
  } catch (error) {
    console.error('Failed to check IP rate limit:', error);
    // Fail open - allow request if Redis is down
    return { allowed: true, remaining: IP_DAILY_LIMIT };
  }
}

// ============================================================================
// LICENSE CACHE
// Cache Polar license validation to reduce API calls
// TTL: 7 days for valid licenses, 1 hour for invalid
// ============================================================================

const LICENSE_CACHE_TTL_VALID = 7 * 24 * 60 * 60; // 7 days
const LICENSE_CACHE_TTL_INVALID = 60 * 60; // 1 hour

export interface CachedLicense {
  valid: boolean;
  credits?: number;
  expiresAt?: string;
  cachedAt: string;
}

export async function getCachedLicense(licenseKey: string): Promise<CachedLicense | null> {
  try {
    const cached = await getRedis().get<CachedLicense>(`license:${licenseKey}`);
    return cached;
  } catch (error) {
    console.error('Failed to get cached license:', error);
    return null;
  }
}

export async function cacheLicense(licenseKey: string, license: CachedLicense): Promise<void> {
  try {
    const ttl = license.valid ? LICENSE_CACHE_TTL_VALID : LICENSE_CACHE_TTL_INVALID;
    await getRedis().set(`license:${licenseKey}`, license, { ex: ttl });
  } catch (error) {
    console.error('Failed to cache license:', error);
  }
}
