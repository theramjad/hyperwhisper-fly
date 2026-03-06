// TRANSCRIPTION ROUTE
// POST /transcribe - Main transcription endpoint
// Supports multiple STT providers with automatic fallback

import type { Context } from 'hono';
import { transcribeWithDeepgram } from '../providers/deepgram';
import { transcribeWithGroq } from '../providers/groq';
import { transcribeWithElevenLabs } from '../providers/elevenlabs';
import type { TranscriptionResult } from '../providers/types';
import { ProviderUnavailableError } from '../providers/types';
import { creditsForCost, formatUsd } from '../lib/cost-calculator';
import { generateRequestId } from '../lib/request-id';
import { MAX_AUDIO_SIZE_BYTES } from '../lib/constants';
import { isIPBlocked } from '../lib/redis';
import {
  errorResponse,
  fileTooLargeResponse,
  invalidContentTypeResponse,
  missingContentLengthResponse,
} from '../lib/responses';
import { validateAuth } from '../middleware/auth';
import { deductCredits, estimateCreditsFromSize, validateCredits } from '../middleware/credits';

// Supported providers
export type Provider = 'deepgram' | 'groq' | 'elevenlabs';

const PROVIDER_NAMES: Record<Provider, string> = {
  deepgram: 'deepgram-nova3',
  elevenlabs: 'elevenlabs-scribe-v2',
  groq: 'groq-whisper-large-v3',
};

// Fallback chains: each provider cascades through alternatives
// ElevenLabs (most expensive) is last resort for the cheaper providers
const FALLBACK_CHAINS: Record<Provider, Provider[]> = {
  elevenlabs: ['elevenlabs', 'deepgram', 'groq'],
  groq: ['groq', 'deepgram', 'elevenlabs'],
  deepgram: ['deepgram', 'groq', 'elevenlabs'],
};

const PROVIDER_FN: Record<Provider, (
  audio: ArrayBuffer,
  contentType: string,
  language?: string,
  initialPrompt?: string,
  context?: { requestId?: string; attempt?: number }
) => Promise<TranscriptionResult>> = {
  deepgram: transcribeWithDeepgram,
  groq: transcribeWithGroq,
  elevenlabs: transcribeWithElevenLabs,
};

function getClientIP(c: Context): string {
  return c.req.header('Fly-Client-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

function extractProvider(c: Context): Provider {
  const header = c.req.header('X-STT-Provider')?.toLowerCase().trim();
  if (header === 'deepgram' || header === 'groq' || header === 'elevenlabs') {
    return header;
  }

  if (header && header !== 'deepgram' && header !== 'groq' && header !== 'elevenlabs') {
    console.warn('Invalid X-STT-Provider header, using default', { provided: header });
  }

  return 'deepgram';
}

function getFlyRequestId(c: Context): string | undefined {
  return c.req.header('Fly-Request-Id')
    || c.req.header('Fly-Request-ID')
    || c.req.header('fly-request-id')
    || undefined;
}

function logTranscribeEvent(
  requestId: string,
  startTime: number,
  event: string,
  details: Record<string, unknown> = {},
) {
  console.log(`transcribe.${event}`, {
    requestId,
    elapsedMs: Math.round(performance.now() - startTime),
    ...details,
  });
}

function validateStreamingHeaders(c: Context):
  | { ok: true; contentType: string; contentLength: number }
  | { ok: false; response: Response } {
  const contentType = c.req.header('Content-Type') || '';
  if (!contentType.startsWith('audio/')) {
    return { ok: false, response: invalidContentTypeResponse('audio/*', contentType) };
  }

  const contentLengthHeader = c.req.header('Content-Length');
  if (!contentLengthHeader) {
    return { ok: false, response: missingContentLengthResponse() };
  }

  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return { ok: false, response: errorResponse(400, 'Invalid Content-Length', 'Content-Length must be a positive integer') };
  }

  if (contentLength > MAX_AUDIO_SIZE_BYTES) {
    return { ok: false, response: fileTooLargeResponse(contentLength, MAX_AUDIO_SIZE_BYTES) };
  }

  return { ok: true, contentType, contentLength };
}

export async function transcribeRoute(c: Context) {
  const requestId = generateRequestId();
  const startTime = performance.now();
  const clientIP = getClientIP(c);
  const flyRequestId = getFlyRequestId(c);

  // IP block check
  if (await isIPBlocked(clientIP)) {
    logTranscribeEvent(requestId, startTime, 'request_rejected', {
      reason: 'ip_blocked',
      flyRequestId,
    });
    return errorResponse(403, 'Access denied', 'Your IP has been temporarily blocked due to abuse');
  }
  logTranscribeEvent(requestId, startTime, 'ip_check_done', { flyRequestId });

  const headerValidation = validateStreamingHeaders(c);
  if (!headerValidation.ok) {
    logTranscribeEvent(requestId, startTime, 'request_rejected', {
      reason: 'invalid_streaming_headers',
      flyRequestId,
      status: headerValidation.response.status,
    });
    return headerValidation.response;
  }

  const { contentType, contentLength } = headerValidation;
  const provider = extractProvider(c);
  const language = c.req.query('language') || undefined;
  const initialPrompt = c.req.query('initial_prompt') || undefined;
  const mode = c.req.query('mode') || undefined;

  logTranscribeEvent(requestId, startTime, 'request_start', {
    flyRequestId,
    flyRegion: process.env.FLY_REGION || 'local',
    provider,
    contentType,
    contentLength,
    language: language || 'auto',
    hasInitialPrompt: Boolean(initialPrompt),
    mode: mode || 'default',
  });

  // Auth (query params only)
  const authResult = await validateAuth({
    licenseKey: c.req.query('license_key') || undefined,
    deviceId: c.req.query('device_id') || undefined,
  });
  if (!authResult.ok) {
    logTranscribeEvent(requestId, startTime, 'request_rejected', {
      reason: 'auth_failed',
      flyRequestId,
      status: authResult.response.status,
    });
    return authResult.response;
  }
  logTranscribeEvent(requestId, startTime, 'auth_done');

  const estimatedCredits = estimateCreditsFromSize(contentLength);
  const creditCheck = await validateCredits(authResult.value, estimatedCredits, clientIP);
  if (!creditCheck.ok) {
    logTranscribeEvent(requestId, startTime, 'request_rejected', {
      reason: 'credits_failed',
      flyRequestId,
      status: creditCheck.response.status,
      estimatedCredits,
    });
    return creditCheck.response;
  }
  logTranscribeEvent(requestId, startTime, 'credits_done', { estimatedCredits });

  const audioBuffer = await c.req.arrayBuffer();
  logTranscribeEvent(requestId, startTime, 'buffer_read_done', {
    audioBytes: audioBuffer.byteLength,
  });

  let result: TranscriptionResult | undefined;
  let fallbackFrom: Provider | undefined;
  let fallbackCount = 0;

  const chain = FALLBACK_CHAINS[provider];
  let lastError: Error | undefined;

  for (const [index, current] of chain.entries()) {
    logTranscribeEvent(requestId, startTime, 'provider_attempt_start', {
      provider: current,
      attempt: index + 1,
    });

    try {
      result = await PROVIDER_FN[current](audioBuffer, contentType, language, initialPrompt, {
        requestId,
        attempt: index + 1,
      });
      if (current !== provider) {
        fallbackFrom = provider;
      }
      logTranscribeEvent(requestId, startTime, 'provider_attempt_done', {
        provider: current,
        attempt: index + 1,
        upstreamRequestId: result.requestId,
        transcriptChars: result.text.length,
        resultSource: result.source,
      });
      break;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        const next = chain[chain.indexOf(current) + 1];
        fallbackCount += 1;
        logTranscribeEvent(requestId, startTime, 'provider_attempt_fail', {
          provider: current,
          attempt: index + 1,
          kind: 'provider_unavailable',
          message: error.message,
          nextProvider: next,
        });
        lastError = error;
        continue;
      }
      // Non-retryable error (401 invalid key, etc.) — don't try fallbacks
      logTranscribeEvent(requestId, startTime, 'request_fail', {
        provider: current,
        attempt: index + 1,
        kind: 'non_retryable',
        message: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(500, 'Transcription failed', error instanceof Error ? error.message : String(error), { requestId });
    }
  }

  // All providers in the chain failed
  if (!result) {
    logTranscribeEvent(requestId, startTime, 'request_fail', {
      kind: 'all_providers_unavailable',
      fallbackCount,
      message: lastError?.message,
    });
    return errorResponse(429, 'All providers unavailable', 'All transcription providers are currently rate-limited. Please try again shortly.', { requestId });
  }
  logTranscribeEvent(requestId, startTime, 'stt_done', {
    provider: result.source,
    upstreamRequestId: result.requestId,
  });

  const actualProvider = PROVIDER_NAMES[result.source as Provider] || PROVIDER_NAMES[provider];
  const providerName = fallbackFrom
    ? `${actualProvider} (fallback from ${PROVIDER_NAMES[fallbackFrom]})`
    : actualProvider;

  const noSpeech = result.source === 'no_speech';
  const creditsUsed = noSpeech ? 0 : creditsForCost(result.costUsd);

  if (!noSpeech) {
    deductCredits(
      authResult.value,
      result.costUsd,
      {
        audio_duration_seconds: result.durationSeconds,
        transcription_cost_usd: result.costUsd,
        language: result.language ?? language ?? 'auto',
        mode,
        endpoint: '/transcribe',
        stt_provider: providerName,
      },
      clientIP
    ).catch(console.error);
  }

  const response = {
    text: result.text,
    language: result.language,
    duration: result.durationSeconds,
    cost: {
      usd: result.costUsd,
      credits: creditsUsed,
    },
    metadata: {
      request_id: requestId,
      stt_provider: providerName,
    },
    ...(noSpeech ? { no_speech_detected: true } : {}),
  };

  c.header('X-Request-ID', requestId);
  c.header('X-STT-Provider', providerName);
  c.header('X-Total-Cost-Usd', formatUsd(result.costUsd));
  c.header('X-Credits-Used', creditsUsed.toFixed(1));

  logTranscribeEvent(requestId, startTime, 'request_done', {
    finalProvider: providerName,
    fallbackCount,
    noSpeech,
    creditsUsed,
  });
  return c.json(response);
}
