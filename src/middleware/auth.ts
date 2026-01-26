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

async function validateLicenseViaApi(licenseKey: string): Promise<{ isValid: boolean; credits: number }> {
  const apiBase = (process.env.NEXTJS_LICENSE_API_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  try {
    const response = await fetch(`${apiBase}/api/license/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        license_key: licenseKey,
        include_credits: true,
      }),
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
  } catch (error) {
    console.error('License validation failed:', error);
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
    return { ok: false, response: noIdentifierResponse() };
  }

  if (licenseKey) {
    if (!forceRefresh) {
      const cached = await getCachedLicense(licenseKey);
      if (cached) {
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
    }

    const validation = await validateLicenseViaApi(licenseKey);
    if (!validation.isValid) {
      return { ok: false, response: invalidLicenseResponse() };
    }

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
  const deviceBalance = await getDeviceBalance(deviceId!);
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
