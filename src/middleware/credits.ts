// CREDIT VALIDATION + DEDUCTION
// Handles preflight credit checks and post-usage deduction

import type { AuthContext } from './auth';
import { BYTES_PER_MINUTE_ESTIMATE, CREDITS_PER_MINUTE, DEFAULT_API_BASE_URL } from '../lib/constants';
import { roundToTenth, roundUpToTenth } from '../lib/utils';
import { creditsForCost } from '../lib/cost-calculator';
import {
  deviceCreditsExhaustedResponse,
  insufficientCreditsResponse,
  ipRateLimitResponse,
} from '../lib/responses';
import { cacheLicense, deductDeviceCredits, getDeviceBalance } from '../lib/redis';
import { checkRateLimit, incrementUsage } from './rate-limit';

// Approximate audio bitrate for credit estimation
// ~1MB per minute (128kbps)
const MIN_ESTIMATED_SECONDS = 10;

export type CreditsResult =
  | { ok: true }
  | { ok: false; response: Response };

export function estimateCreditsFromSize(sizeBytes: number): number {
  const estimatedMinutes = sizeBytes / BYTES_PER_MINUTE_ESTIMATE;
  const estimatedSeconds = Math.max(MIN_ESTIMATED_SECONDS, estimatedMinutes * 60);
  const estimatedCredits = (estimatedSeconds / 60) * CREDITS_PER_MINUTE;
  return Math.max(0.1, roundUpToTenth(estimatedCredits));
}

export async function validateCredits(
  auth: AuthContext,
  estimatedCredits: number,
  clientIP: string
): Promise<CreditsResult> {
  if (auth.type === 'licensed') {
    const balance = roundToTenth(auth.credits);
    if (balance < estimatedCredits) {
      return { ok: false, response: insufficientCreditsResponse(balance, estimatedCredits) };
    }
    return { ok: true };
  }

  // Trial users: check device credits + IP quota
  const deviceBalance = await getDeviceBalance(auth.identifier);
  if (deviceBalance.isExhausted || deviceBalance.creditsRemaining < estimatedCredits) {
    return {
      ok: false,
      response: deviceCreditsExhaustedResponse(
        deviceBalance.creditsRemaining,
        deviceBalance.totalAllocated
      ),
    };
  }

  const rateLimit = await checkRateLimit(clientIP, estimatedCredits);
  if (!rateLimit.allowed) {
    return { ok: false, response: ipRateLimitResponse(rateLimit.resetsAt) };
  }

  return { ok: true };
}

async function recordLicenseUsage(
  licenseKey: string,
  creditsUsed: number,
  metadata: Record<string, unknown>
): Promise<void> {
  const apiBase = (process.env.NEXTJS_LICENSE_API_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  try {
    const response = await fetch(`${apiBase}/api/license/credits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        license_key: licenseKey,
        amount: creditsUsed,
        metadata,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn('POST /api/license/credits failed', {
        status: response.status,
        error: (errorData as Record<string, unknown>).error || 'Unknown error',
        creditsUsed,
      });
      return;
    }

    const data = await response.json() as { credits_remaining?: number; credits_deducted?: number };
    if (typeof data.credits_remaining === 'number') {
      await cacheLicense(licenseKey, {
        isValid: true,
        credits: data.credits_remaining,
        cachedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.warn('POST /api/license/credits network error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function deductCredits(
  auth: AuthContext,
  costUsd: number,
  metadata: Record<string, unknown>,
  clientIP: string
): Promise<number> {
  const creditsUsed = creditsForCost(costUsd);

  if (creditsUsed <= 0) {
    return 0;
  }

  if (auth.type === 'licensed') {
    await recordLicenseUsage(auth.identifier, creditsUsed, metadata);
    return creditsUsed;
  }

  try {
    await Promise.all([
      deductDeviceCredits(auth.identifier, creditsUsed),
      incrementUsage(clientIP, creditsUsed),
    ]);
  } catch (error) {
    console.warn('Failed to deduct trial credits', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return creditsUsed;
}
