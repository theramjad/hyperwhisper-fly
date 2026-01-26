// IP RATE LIMITING (CREDITS-BASED)
// Anonymous users limited to daily credits per IP

import { CREDITS_PER_MINUTE, TRIAL_CREDIT_ALLOCATION } from '../lib/constants';
import { redis } from '../lib/redis';
import { roundToTenth } from '../lib/utils';

const DAILY_FREE_CREDITS = TRIAL_CREDIT_ALLOCATION;

export interface RateLimitStatus {
  allowed: boolean;
  creditsUsed: number;
  creditsRemaining: number;
  resetsAt: Date;
  isAnonymous: true;
}

function getCurrentDateKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getResetTime(): Date {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

function secondsUntilReset(): number {
  const resetTime = getResetTime().getTime();
  const diff = Math.max(0, resetTime - Date.now());
  return Math.floor(diff / 1000);
}

export async function checkRateLimit(ip: string, estimatedCredits: number): Promise<RateLimitStatus> {
  const dateKey = getCurrentDateKey();
  const rateLimitKey = `ip_daily:${ip}:${dateKey}`;

  try {
    const raw = await redis.get().get(rateLimitKey);
    const parsed = raw ? Number.parseFloat(String(raw)) : 0;
    const creditsUsed = Number.isFinite(parsed) ? roundToTenth(parsed) : 0;

    const creditsAfterRequest = roundToTenth(creditsUsed + estimatedCredits);
    const allowed = creditsAfterRequest <= DAILY_FREE_CREDITS;
    const creditsRemaining = roundToTenth(Math.max(0, DAILY_FREE_CREDITS - creditsUsed));

    return {
      allowed,
      creditsUsed,
      creditsRemaining,
      resetsAt: getResetTime(),
      isAnonymous: true,
    };
  } catch (error) {
    console.error('IP rate limit check failed - denying for safety', {
      error: error instanceof Error ? error.message : String(error),
      ip,
    });

    return {
      allowed: false,
      creditsUsed: DAILY_FREE_CREDITS,
      creditsRemaining: 0,
      resetsAt: getResetTime(),
      isAnonymous: true,
    };
  }
}

export async function incrementUsage(ip: string, creditsUsed: number): Promise<void> {
  const dateKey = getCurrentDateKey();
  const rateLimitKey = `ip_daily:${ip}:${dateKey}`;

  try {
    const raw = await redis.get().get(rateLimitKey);
    const parsed = raw ? Number.parseFloat(String(raw)) : 0;
    const currentCredits = Number.isFinite(parsed) ? roundToTenth(parsed) : 0;
    const normalizedUsage = roundToTenth(creditsUsed);
    const newCredits = roundToTenth(currentCredits + normalizedUsage);

    const expirationTtl = secondsUntilReset() + 3600; // 1h buffer

    await redis.get().set(rateLimitKey, newCredits.toFixed(1), { ex: expirationTtl });
  } catch (error) {
    console.error('Failed to update IP quota', {
      error: error instanceof Error ? error.message : String(error),
      ip,
    });
  }
}

export async function getUsageStats(ip: string): Promise<{ creditsUsed: number; creditsRemaining: number; minutesRemaining: number; resetsAt: Date }> {
  const dateKey = getCurrentDateKey();
  const rateLimitKey = `ip_daily:${ip}:${dateKey}`;

  try {
    const raw = await redis.get().get(rateLimitKey);
    const parsed = raw ? Number.parseFloat(String(raw)) : 0;
    const creditsUsed = Number.isFinite(parsed) ? roundToTenth(parsed) : 0;
    const creditsRemaining = roundToTenth(Math.max(0, DAILY_FREE_CREDITS - creditsUsed));
    const minutesRemaining = Math.floor(creditsRemaining / CREDITS_PER_MINUTE);

    return {
      creditsUsed,
      creditsRemaining,
      minutesRemaining,
      resetsAt: getResetTime(),
    };
  } catch {
    return {
      creditsUsed: 0,
      creditsRemaining: DAILY_FREE_CREDITS,
      minutesRemaining: Math.floor(DAILY_FREE_CREDITS / CREDITS_PER_MINUTE),
      resetsAt: getResetTime(),
    };
  }
}
