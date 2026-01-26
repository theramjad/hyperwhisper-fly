// USAGE ROUTE
// GET /usage - Query credit balance and rate limits

import type { Context } from 'hono';
import { CREDITS_PER_MINUTE, DEFAULT_API_BASE_URL } from '../lib/constants';
import { getCachedLicense, cacheLicense, getDeviceBalance } from '../lib/redis';
import { errorResponse, jsonResponse } from '../lib/responses';
import { getUsageStats } from '../middleware/rate-limit';
import { isIPBlocked } from '../lib/redis';
import { roundToTenth } from '../lib/utils';

function getClientIP(c: Context): string {
  return c.req.header('Fly-Client-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

function looksLikeDeviceId(value: string): boolean {
  const sha256HexPattern = /^[a-f0-9]{64}$/;
  if (sha256HexPattern.test(value)) {
    return true;
  }
  if (value.length >= 40 && /^[a-f0-9]+$/.test(value)) {
    return true;
  }
  return false;
}

function resolveIdentifier(licenseKey: string | null, deviceId: string | null, identifier: string | null): {
  licenseKey: string | null;
  deviceId: string | null;
} {
  if (licenseKey) {
    return { licenseKey, deviceId };
  }

  if (!identifier) {
    return { licenseKey: null, deviceId };
  }

  const trimmed = identifier.trim();
  if (!trimmed) {
    return { licenseKey: null, deviceId };
  }

  if (looksLikeDeviceId(trimmed)) {
    return { licenseKey: null, deviceId: deviceId || trimmed };
  }

  return { licenseKey: trimmed, deviceId };
}

async function validateLicenseAndGetCredits(licenseKey: string, forceRefresh: boolean): Promise<{ isValid: boolean; credits: number }> {
  if (!forceRefresh) {
    const cached = await getCachedLicense(licenseKey);
    if (cached) {
      return { isValid: cached.isValid, credits: cached.credits };
    }
  }

  const apiBase = (process.env.NEXTJS_LICENSE_API_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  try {
    const response = await fetch(`${apiBase}/api/license/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, include_credits: true }),
    });

    const data = await response.json().catch(() => ({})) as { valid?: boolean; credits?: number };
    const isValid = data.valid === true;
    const credits = typeof data.credits === 'number' ? data.credits : 0;

    await cacheLicense(licenseKey, {
      isValid,
      credits,
      cachedAt: new Date().toISOString(),
    });

    return { isValid, credits };
  } catch {
    return { isValid: false, credits: 0 };
  }
}

async function getCreditsBalance(licenseKey: string): Promise<{ credits: number; error?: string }> {
  const apiBase = (process.env.NEXTJS_LICENSE_API_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  try {
    const response = await fetch(`${apiBase}/api/license/credits?license_key=${encodeURIComponent(licenseKey)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string };
      return { credits: 0, error: errorData.error || `HTTP ${response.status}` };
    }

    const data = await response.json() as { credits: number };
    await cacheLicense(licenseKey, {
      isValid: true,
      credits: data.credits,
      cachedAt: new Date().toISOString(),
    });

    return { credits: data.credits };
  } catch (error) {
    return { credits: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function usageRoute(c: Context) {
  const clientIP = getClientIP(c);

  if (await isIPBlocked(clientIP)) {
    return errorResponse(403, 'Access denied', 'Your IP has been temporarily blocked due to abuse');
  }

  const licenseKeyParam = c.req.query('license_key');
  const deviceIdParam = c.req.query('device_id');
  const identifier = c.req.query('identifier');
  const forceRefresh = c.req.query('force_refresh') === 'true';

  const resolved = resolveIdentifier(licenseKeyParam || null, deviceIdParam || null, identifier || null);
  const licenseKey = resolved.licenseKey;
  const deviceId = resolved.deviceId;

  if (licenseKey) {
    let isValid = false;
    let credits = 0;

    if (forceRefresh) {
      const cached = await getCachedLicense(licenseKey);
      if (cached?.isValid) {
        const balanceResult = await getCreditsBalance(licenseKey);
        if (balanceResult.error) {
          const validation = await validateLicenseAndGetCredits(licenseKey, true);
          isValid = validation.isValid;
          credits = validation.credits;
        } else {
          isValid = true;
          credits = balanceResult.credits;
        }
      } else {
        const validation = await validateLicenseAndGetCredits(licenseKey, true);
        isValid = validation.isValid;
        credits = validation.credits;
      }
    } else {
      const validation = await validateLicenseAndGetCredits(licenseKey, false);
      isValid = validation.isValid;
      credits = validation.credits;
    }

    if (!isValid) {
      return errorResponse(401, 'Invalid license key', 'The provided license key is invalid or expired');
    }

    const normalizedCredits = roundToTenth(credits);
    const minutesRemaining = Math.floor(normalizedCredits / CREDITS_PER_MINUTE);

    const response = {
      credits_remaining: normalizedCredits,
      minutes_remaining: minutesRemaining,
      credits_per_minute: CREDITS_PER_MINUTE,
      is_licensed: true,
      is_trial: false,
      is_anonymous: false,
    };

    return jsonResponse(response);
  }

  if (deviceId) {
    const deviceBalance = await getDeviceBalance(deviceId);
    const ipStats = await getUsageStats(clientIP);

    const response = {
      credits_remaining: deviceBalance.creditsRemaining,
      minutes_remaining: deviceBalance.minutesRemaining,
      credits_per_minute: CREDITS_PER_MINUTE,
      device_id: deviceId,
      total_allocated: deviceBalance.totalAllocated,
      credits_used: deviceBalance.creditsUsed,
      is_licensed: false,
      is_trial: true,
      is_anonymous: false,
      resets_at: ipStats.resetsAt.toISOString(),
    };

    return jsonResponse(response, {
      'X-Device-Credits-Remaining': deviceBalance.creditsRemaining.toFixed(1),
      'X-IP-RateLimit-Remaining': ipStats.creditsRemaining.toFixed(1),
    });
  }

  return errorResponse(401, 'Identifier required', 'You must provide either a license_key or device_id parameter');
}
