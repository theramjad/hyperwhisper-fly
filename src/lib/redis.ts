// UPSTASH REDIS CLIENT
// Serverless Redis for rate limiting, device credits, and license caching
// Works globally with Fly.io's anycast routing

import { Redis } from '@upstash/redis';
import { CREDITS_PER_MINUTE, LICENSE_CACHE_TTL_SECONDS, TRIAL_CREDIT_ALLOCATION } from './constants';
import { roundToTenth } from './utils';

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
// DEVICE CREDITS (trial users)
// ============================================================================

export interface DeviceCreditsBalance {
  creditsRemaining: number;
  totalAllocated: number;
  creditsUsed: number;
  minutesRemaining: number;
  isExhausted: boolean;
}

async function initializeDevice(deviceId: string): Promise<void> {
  const deviceKey = `device_credits:${deviceId}`;
  const initialBalance = {
    credits_remaining: TRIAL_CREDIT_ALLOCATION,
    total_allocated: TRIAL_CREDIT_ALLOCATION,
    credits_used: 0,
  };

  await getRedis().set(deviceKey, initialBalance);
}

function normalizeDeviceBalance(raw: any): DeviceCreditsBalance {
  const creditsRemaining = roundToTenth(raw?.credits_remaining ?? raw?.creditsRemaining ?? 0);
  const creditsUsed = roundToTenth(raw?.credits_used ?? raw?.creditsUsed ?? 0);
  const totalAllocated = raw?.total_allocated ?? raw?.totalAllocated ?? TRIAL_CREDIT_ALLOCATION;
  const minutesRemaining = Math.floor(creditsRemaining / CREDITS_PER_MINUTE);

  return {
    creditsRemaining,
    totalAllocated,
    creditsUsed,
    minutesRemaining,
    isExhausted: creditsRemaining <= 0,
  };
}

export async function getDeviceBalance(deviceId: string): Promise<DeviceCreditsBalance> {
  const deviceKey = `device_credits:${deviceId}`;

  try {
    const raw = await getRedis().get(deviceKey);

    if (!raw) {
      await initializeDevice(deviceId);
      return normalizeDeviceBalance({
        credits_remaining: TRIAL_CREDIT_ALLOCATION,
        total_allocated: TRIAL_CREDIT_ALLOCATION,
        credits_used: 0,
      });
    }

    if (typeof raw === 'string') {
      return normalizeDeviceBalance(JSON.parse(raw));
    }

    return normalizeDeviceBalance(raw);
  } catch (error) {
    console.error('Failed to get device credits:', error);
    // Fail closed to prevent abuse if Redis is unavailable
    return {
      creditsRemaining: 0,
      totalAllocated: TRIAL_CREDIT_ALLOCATION,
      creditsUsed: TRIAL_CREDIT_ALLOCATION,
      minutesRemaining: 0,
      isExhausted: true,
    };
  }
}

export async function deductDeviceCredits(deviceId: string, amount: number): Promise<DeviceCreditsBalance> {
  const deviceKey = `device_credits:${deviceId}`;

  try {
    const current = await getDeviceBalance(deviceId);
    const newCreditsUsed = roundToTenth(current.creditsUsed + amount);
    const newCreditsRemaining = roundToTenth(Math.max(0, current.creditsRemaining - amount));

    const updated = {
      credits_remaining: newCreditsRemaining,
      total_allocated: current.totalAllocated,
      credits_used: newCreditsUsed,
    };

    await getRedis().set(deviceKey, updated);

    return normalizeDeviceBalance(updated);
  } catch (error) {
    console.error('Failed to deduct device credits:', error);
    throw error;
  }
}

// ============================================================================
// IP BLOCKING + DAILY QUOTA (credits-based)
// ============================================================================

export async function isIPBlocked(ip: string): Promise<boolean> {
  try {
    const blockKey = `ip_blocked:${ip}`;
    const blocked = await getRedis().get(blockKey);
    return blocked === 'true';
  } catch {
    return false;
  }
}

export async function getIPDailyUsage(ip: string, dateKey: string): Promise<number> {
  const key = `ip_daily:${ip}:${dateKey}`;
  try {
    const raw = await getRedis().get(key);
    if (!raw) return 0;
    const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    return Number.isFinite(parsed) ? roundToTenth(parsed) : 0;
  } catch {
    return 0;
  }
}

export async function setIPDailyUsage(ip: string, dateKey: string, credits: number, ttlSeconds: number): Promise<void> {
  const key = `ip_daily:${ip}:${dateKey}`;
  await getRedis().set(key, credits.toFixed(1), { ex: ttlSeconds });
}

// ============================================================================
// LICENSE CACHE (1 hour TTL for valid + invalid)
// ============================================================================

export interface CachedLicense {
  isValid: boolean;
  credits: number;
  cachedAt: string;
}

export async function getCachedLicense(licenseKey: string): Promise<CachedLicense | null> {
  try {
    const cached = await getRedis().get<CachedLicense>(`license:${licenseKey}`);
    if (!cached) return null;

    if (typeof cached === 'string') {
      return JSON.parse(cached) as CachedLicense;
    }

    return cached;
  } catch (error) {
    console.error('Failed to get cached license:', error);
    return null;
  }
}

export async function cacheLicense(licenseKey: string, license: CachedLicense): Promise<void> {
  try {
    await getRedis().set(`license:${licenseKey}`, license, { ex: LICENSE_CACHE_TTL_SECONDS });
  } catch (error) {
    console.error('Failed to cache license:', error);
  }
}
