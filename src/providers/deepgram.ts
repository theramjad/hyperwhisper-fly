// DEEPGRAM NOVA-3 PROVIDER
// Primary STT provider - $0.0055/min, best accuracy with vocabulary boosting

import { computeDeepgramTranscriptionCost } from '../lib/cost-calculator';
import { ProviderUnavailableError } from './types';
import type { ProviderRequestContext, TranscriptionResult } from './types';
import { fetchWithTimeout, logProviderEvent, readErrorBodyPreview } from './utils';

// Maximum keywords Deepgram accepts
const MAX_KEYWORDS = 100;

/**
 * Convert initial prompt to Deepgram keyterm format
 * Input: "HyperWhisper,SwiftUI,Claude"
 * Output: "HyperWhisper,SwiftUI,Claude" (plain strings for keyterm)
 */
function convertToKeyterms(initialPrompt: string): string {
  const terms = initialPrompt
    .split(/[,\n;]+/)
    .map(t => t.trim().replace(/^[-*]\s*/, ''))
    .filter(t => t.length > 0 && t.length <= 50)
    .slice(0, MAX_KEYWORDS);

  return terms.join(',');
}

/**
 * Build Deepgram API URL with query parameters
 */
function buildDeepgramUrl(language?: string, vocabularyTerms?: string): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    utterances: 'true',
  });

  const isMonolingual = language && language.toLowerCase() !== 'auto';

  if (isMonolingual) {
    params.set('language', language.toLowerCase());
  } else {
    params.set('detect_language', 'true');
  }

  // Keyterm works for Nova-3 in both modes
  if (vocabularyTerms && vocabularyTerms.length > 0) {
    params.set('keyterm', vocabularyTerms);
  }

  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
}

/**
 * Transcribe audio with Deepgram Nova-3
 */
export async function transcribeWithDeepgram(
  audio: ArrayBuffer,
  contentType: string,
  language?: string,
  initialPrompt?: string,
  context: ProviderRequestContext = {},
): Promise<TranscriptionResult> {
  const startedAt = performance.now();
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPGRAM_API_KEY not configured');
  }

  const keyterms = initialPrompt ? convertToKeyterms(initialPrompt) : '';
  const url = buildDeepgramUrl(language, keyterms);
  const provider = 'deepgram';

  logProviderEvent(provider, 'prepare', {
    audioBytes: audio.byteLength,
    contentType,
    language: language || 'auto',
    keytermCount: keyterms ? keyterms.split(',').length : 0,
  }, context);

  const response = await fetchWithTimeout(provider, url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': contentType,
    },
    body: audio,
  }, context);

  if (!response.ok) {
    const errorText = await readErrorBodyPreview(response);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const kind = response.status >= 500 ? 'upstream_5xx' : response.status === 429 ? 'rate_limit' : 'http_error';

    logProviderEvent(provider, 'http_error', {
      elapsedMs,
      status: response.status,
      kind,
      bodyPreview: errorText,
    }, context);

    if (response.status === 401) {
      throw new Error('Deepgram API key is invalid or expired');
    }
    if (response.status === 402) {
      throw new Error('Deepgram account has insufficient funds');
    }
    if (response.status === 429) {
      throw new ProviderUnavailableError('Deepgram', 'rate limit exceeded');
    }
    if (response.status >= 500) {
      throw new ProviderUnavailableError('Deepgram', `upstream 5xx: ${response.status}`);
    }

    throw new Error(`Deepgram error: ${response.status}`);
  }

  const data = await response.json() as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>;
        detected_language?: string;
      }>;
    };
    metadata?: {
      duration?: number;
      request_id?: string;
    };
  };

  const channel = data.results?.channels?.[0];
  const transcript = channel?.alternatives?.[0]?.transcript || '';
  const duration = data.metadata?.duration || 0;

  if (!transcript || transcript.trim().length === 0) {
    logProviderEvent(provider, 'no_speech', {
      elapsedMs: Math.round(performance.now() - startedAt),
      detectedLanguage: channel?.detected_language,
    }, context);
    return {
      text: '',
      language: channel?.detected_language,
      durationSeconds: 0,
      costUsd: 0,
      source: 'no_speech',
      requestId: data.metadata?.request_id,
    };
  }

  logProviderEvent(provider, 'success', {
    elapsedMs: Math.round(performance.now() - startedAt),
    transcriptChars: transcript.length,
    durationSeconds: duration,
    detectedLanguage: channel?.detected_language,
  }, context);

  return {
    text: transcript,
    language: channel?.detected_language,
    durationSeconds: duration,
    costUsd: computeDeepgramTranscriptionCost(duration),
    source: 'deepgram',
    requestId: data.metadata?.request_id,
  };
}
