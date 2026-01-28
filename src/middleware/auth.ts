// AUTHENTICATION HELPERS
// Validates license keys and device trial identifiers

import { DEFAULT_API_BASE_URL } from '../lib/constants';
import { cacheLicense, getCachedLicense, getDeviceBalance } from '../lib/redis';
import { invalidLicenseResponse, noIdentifierResponse } from '../lib/responses';

export interface AuthContext {
  type: 'licensed' | 'trial';
  identifier: string; // license_key or device_id
  credits: number;
  licenseKey?: string;
  deviceId?: string;
}

export interface AuthInput {
  licenseKey?: string;
  deviceId?: string;
}

export type AuthResult =
  | { ok: true; value: AuthContext }
  | { ok: false; response: Response };

// Mask license key for logging (show first 4 and last 4 chars)
function maskLicenseKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

async function validateLicenseViaApi(licenseKey: string): Promise<{ isValid: boolean; credits: number }> {
  const apiBase = (process.env.NEXTJS_LICENSE_API_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const validateUrl = `${apiBase}/api/license/validate`;
  const maskedKey = maskLicenseKey(licenseKey);

  console.log(`[License] Validating ${maskedKey} via ${validateUrl}`);

  try {
    const response = await fetch(validateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        license_key: licenseKey,
        include_credits: true,
      }),
    });

    const responseText = await response.text();
    let data: { valid?: boolean; credits?: number; error?: string } = {};

    try {
      data = JSON.parse(responseText);
    } catch {
      console.error(`[License] Invalid JSON response for ${maskedKey}: ${responseText.slice(0, 200)}`);
    }

    const isValid = data.valid === true;
    const credits = typeof data.credits === 'number' ? data.credits : 0;

    console.log(`[License] ${maskedKey}: status=${response.status}, valid=${isValid}, credits=${credits}${data.error ? `, error=${data.error}` : ''}`);

    await cacheLicense(licenseKey, {
      isValid,
      credits,
      cachedAt: new Date().toISOString(),
    });

    return { isValid, credits };
  } catch (error) {
    console.error(`[License] Validation failed for ${maskedKey}:`, error);
    await cacheLicense(licenseKey, {
      isValid: false,
      credits: 0,
      cachedAt: new Date().toISOString(),
    });
    return { isValid: false, credits: 0 };
  }
}

export async function validateAuth(input: AuthInput, forceRefresh = false): Promise<AuthResult> {
  const { licenseKey, deviceId } = input;

  if (!licenseKey && !deviceId) {
    console.log('[Auth] No license_key or device_id provided');
    return { ok: false, response: noIdentifierResponse() };
  }

  if (licenseKey) {
    const maskedKey = maskLicenseKey(licenseKey);

    if (!forceRefresh) {
      const cached = await getCachedLicense(licenseKey);
      if (cached) {
        console.log(`[Auth] Cache HIT for ${maskedKey}: valid=${cached.isValid}, credits=${cached.credits}, cachedAt=${cached.cachedAt}`);
        if (!cached.isValid) {
          return { ok: false, response: invalidLicenseResponse() };
        }
        return {
          ok: true,
          value: {
            type: 'licensed',
            identifier: licenseKey,
            credits: cached.credits,
            licenseKey,
          },
        };
      }
      console.log(`[Auth] Cache MISS for ${maskedKey}, calling API...`);
    } else {
      console.log(`[Auth] Force refresh for ${maskedKey}, bypassing cache...`);
    }

    const validation = await validateLicenseViaApi(licenseKey);
    if (!validation.isValid) {
      console.log(`[Auth] License ${maskedKey} is INVALID`);
      return { ok: false, response: invalidLicenseResponse() };
    }

    console.log(`[Auth] License ${maskedKey} is VALID with ${validation.credits} credits`);
    return {
      ok: true,
      value: {
        type: 'licensed',
        identifier: licenseKey,
        credits: validation.credits,
        licenseKey,
      },
    };
  }

  // Trial user
  console.log(`[Auth] Trial user with device_id: ${deviceId!.slice(0, 8)}...`);
  const deviceBalance = await getDeviceBalance(deviceId!);
  console.log(`[Auth] Trial device has ${deviceBalance.creditsRemaining} credits remaining`);
  return {
    ok: true,
    value: {
      type: 'trial',
      identifier: deviceId!,
      credits: deviceBalance.creditsRemaining,
      deviceId: deviceId!,
    },
  };
}
