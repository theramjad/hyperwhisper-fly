// LLM PROVIDER SELECTION + RETRY

import { retryWithBackoff } from './utils';
import type { CorrectionRequestPayload } from '../providers/groq-llm';
import { requestCerebrasChat } from '../providers/cerebras';
import { requestGroqChat } from '../providers/groq-llm';

export type LLMProvider = 'cerebras' | 'groq';

export const DEFAULT_LLM_PROVIDER: LLMProvider = 'cerebras';

export const LLM_PROVIDER_NAMES: Record<LLMProvider, string> = {
  cerebras: 'cerebras-gpt-oss-120b',
  groq: 'groq-gpt-oss-120b',
};

/**
 * Extract LLM provider from X-LLM-Provider header.
 * Returns default provider if header is missing or invalid.
 */
export function extractLLMProvider(request: Request): LLMProvider {
  const header = request.headers.get('x-llm-provider')?.toLowerCase().trim();

  if (header === 'groq') {
    return 'groq';
  }
  if (header === 'cerebras') {
    return 'cerebras';
  }

  return DEFAULT_LLM_PROVIDER;
}

/**
 * Retry LLM call with exponential backoff
 */
export async function callWithRetry(
  provider: LLMProvider,
  payload: CorrectionRequestPayload,
  requestId: string,
  maxRetries: number
): Promise<Awaited<ReturnType<typeof requestCerebrasChat>>> {
  return retryWithBackoff(
    () => provider === 'cerebras'
      ? requestCerebrasChat(payload, requestId)
      : requestGroqChat(payload, requestId),
    {
      maxRetries,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      onRetry: (attempt, error, delayMs) => {
        console.warn(`[llm] ${provider} failed - retrying`, {
          attempt,
          error: error.message,
          delayMs,
        });
      },
    }
  );
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    return status;
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') {
    const match = message.match(/status\s+(\d{3})/i);
    if (match) {
      return Number(match[1]);
    }
  }

  return undefined;
}

/**
 * Check if an error should trigger provider fallback (5xx).
 */
export function shouldFallback(error: unknown): boolean {
  const status = getErrorStatus(error);
  return typeof status === 'number' && status >= 500 && status <= 599;
}
