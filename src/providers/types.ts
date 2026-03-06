export type TranscriptionSource = 'deepgram' | 'elevenlabs' | 'groq' | 'no_speech';

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds: number;
  costUsd: number;
  source: TranscriptionSource;
  requestId?: string;
}

export interface ProviderRequestContext {
  requestId?: string;
  attempt?: number;
}

/**
 * Thrown when a provider is temporarily unavailable (429, 403 edge block, etc.)
 * Signals the fallback chain to try the next provider.
 */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, reason: string) {
    super(`${provider} unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}
