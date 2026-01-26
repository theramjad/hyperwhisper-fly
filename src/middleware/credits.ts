// CREDIT DEDUCTION
// Non-blocking credit deduction for transcription costs

import type { AuthContext } from './auth';
import { deductDeviceCredits } from '../lib/redis';

// 1 credit = $0.01
const CREDITS_PER_USD = 100;

/**
 * Deduct credits for a transcription request
 * This is called non-blocking after the transcription completes
 *
 * @param auth - Auth context with user type and identifier
 * @param costUsd - Cost of the transcription in USD
 */
export async function deductCredits(auth: AuthContext, costUsd: number): Promise<void> {
  if (costUsd <= 0) {
    return;
  }

  const creditsToDeduct = costUsd * CREDITS_PER_USD;

  if (auth.type === 'trial') {
    // Deduct from device credits for trial users
    try {
      const newBalance = await deductDeviceCredits(auth.identifier, creditsToDeduct);
      console.log(`Deducted ${creditsToDeduct.toFixed(4)} credits from device ${auth.identifier.slice(0, 8)}..., new balance: ${newBalance.toFixed(4)}`);
    } catch (error) {
      console.error('Failed to deduct device credits:', error);
    }
  } else if (auth.type === 'licensed') {
    // For licensed users, we track usage via Polar meters
    // This would call the Polar API to record usage
    // For now, just log it
    console.log(`Licensed user ${auth.identifier.slice(0, 8)}... used ${creditsToDeduct.toFixed(4)} credits ($${costUsd.toFixed(6)})`);

    // TODO: Implement Polar meter tracking
    // await trackPolarUsage(auth.identifier, costUsd);
  }
}

/**
 * Calculate cost in credits from USD
 */
export function usdToCredits(costUsd: number): number {
  return costUsd * CREDITS_PER_USD;
}
