// ELEVENLABS SCRIBE PROVIDER
// High accuracy STT - $0.00983/min using Scribe v2

import { computeElevenLabsTranscriptionCost } from '../lib/cost-calculator';
import { ProviderUnavailableError } from './types';
import type { ProviderRequestContext, TranscriptionResult } from './types';
import { fetchWithTimeout, logProviderEvent, readErrorBodyPreview } from './utils';

/**
 * Transcribe audio with ElevenLabs Scribe v2
 */
export async function transcribeWithElevenLabs(
  audio: ArrayBuffer,
  contentType: string,
  language?: string,
  _initialPrompt?: string,  // ElevenLabs doesn't support prompt
  context: ProviderRequestContext = {},
): Promise<TranscriptionResult> {
  const startTime = performance.now();
  const provider = 'elevenlabs';
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }

  // Determine file extension from content type
  let ext = 'mp3';
  if (contentType.includes('wav')) ext = 'wav';
  else if (contentType.includes('m4a') || contentType.includes('mp4')) ext = 'm4a';
  else if (contentType.includes('webm')) ext = 'webm';
  else if (contentType.includes('ogg')) ext = 'ogg';
  else if (contentType.includes('flac')) ext = 'flac';

  const formData = new FormData();
  formData.append('file', new Blob([audio], { type: contentType }), `audio.${ext}`);
  formData.append('model_id', 'scribe_v2');
  formData.append('tag_audio_events', 'false');

  // ElevenLabs uses different language code format
  if (language && language.toLowerCase() !== 'auto') {
    formData.append('language_code', language.toLowerCase());
  }

  logProviderEvent(provider, 'prepare', {
    audioBytes: audio.byteLength,
    contentType,
    language: language || 'auto',
  }, context);

  const response = await fetchWithTimeout(provider, 'https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
    },
    body: formData,
  }, context);

  if (!response.ok) {
    const errorText = await readErrorBodyPreview(response);
    const elapsedMs = Math.round(performance.now() - startTime);
    const kind = response.status >= 500 ? 'upstream_5xx' : response.status === 429 ? 'rate_limit' : 'http_error';

    logProviderEvent(provider, 'http_error', {
      elapsedMs,
      status: response.status,
      kind,
      bodyPreview: errorText,
    }, context);

    if (response.status === 401) {
      throw new Error('ElevenLabs API key is invalid');
    }
    if (response.status === 429) {
      throw new ProviderUnavailableError('ElevenLabs', 'rate limit exceeded');
    }
    if (response.status >= 500) {
      throw new ProviderUnavailableError('ElevenLabs', `upstream 5xx: ${response.status}`);
    }

    throw new Error(`ElevenLabs error: ${response.status}`);
  }

  const data = await response.json() as {
    text?: string;
    language_code?: string;
    language_probability?: number;
    words?: Array<{ start: number; end: number; text: string }>;
  };

  // Calculate duration from word timings
  let duration = 0;
  if (data.words && data.words.length > 0) {
    const lastWord = data.words[data.words.length - 1];
    duration = lastWord.end;
  }

  const transcript = data.text || '';

  if (!transcript || transcript.trim().length === 0) {
    logProviderEvent(provider, 'no_speech', {
      elapsedMs: Math.round(performance.now() - startTime),
      language: data.language_code,
    }, context);
    return {
      text: '',
      language: data.language_code,
      durationSeconds: 0,
      costUsd: 0,
      source: 'no_speech',
    };
  }

  logProviderEvent(provider, 'success', {
    elapsedMs: Math.round(performance.now() - startTime),
    transcriptChars: transcript.length,
    durationSeconds: duration,
    language: data.language_code,
  }, context);

  return {
    text: transcript,
    language: data.language_code,
    durationSeconds: duration,
    costUsd: computeElevenLabsTranscriptionCost(duration),
    source: 'elevenlabs',
  };
}
