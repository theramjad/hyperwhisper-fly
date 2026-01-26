// GROQ WHISPER PROVIDER
// Fastest and cheapest STT - $0.00185/min using whisper-large-v3

import { computeGroqTranscriptionCost } from '../lib/cost-calculator';
import type { TranscriptionResult } from './types';

/**
 * Custom error for Groq edge blocking (403 Forbidden)
 * Triggers fallback to Deepgram
 */
export class GroqEdgeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroqEdgeBlockedError';
  }
}

/**
 * Get file extension from content type
 */
function getExtension(contentType: string): string {
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mp3')) return 'mp3';
  if (contentType.includes('m4a') || contentType.includes('mp4')) return 'm4a';
  if (contentType.includes('webm')) return 'webm';
  if (contentType.includes('ogg')) return 'ogg';
  if (contentType.includes('flac')) return 'flac';
  return 'wav';
}

/**
 * Transcribe audio with Groq Whisper large-v3
 */
export async function transcribeWithGroq(
  audio: ArrayBuffer,
  contentType: string,
  language?: string,
  initialPrompt?: string
): Promise<TranscriptionResult> {
  const startTime = performance.now();
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const ext = getExtension(contentType);
  const formData = new FormData();

  formData.append('file', new Blob([audio], { type: contentType }), `audio.${ext}`);
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'verbose_json');

  if (language && language.toLowerCase() !== 'auto') {
    formData.append('language', language.toLowerCase());
  }
  if (initialPrompt) {
    formData.append('prompt', initialPrompt);
  }

  const formDataMs = performance.now() - startTime;
  console.log(`Groq request: ${audio.byteLength} bytes, language=${language || 'auto'}`);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });
  const fetchMs = performance.now() - startTime;

  // Handle 403 Forbidden - Groq sometimes blocks edge regions
  if (response.status === 403) {
    throw new GroqEdgeBlockedError('Groq returned 403 Forbidden - likely edge region blocked');
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Groq error ${response.status}: ${errorText}`);

    if (response.status === 401) {
      throw new Error('Groq API key is invalid');
    }
    if (response.status === 429) {
      throw new Error('Groq rate limit exceeded');
    }

    throw new Error(`Groq error: ${response.status}`);
  }

  const data = await response.json() as {
    text?: string;
    language?: string;
    duration?: number;
  };

  const duration = data.duration || 0;

  const transcript = data.text || '';

  if (!transcript || transcript.trim().length === 0) {
    console.log('Groq returned no speech');
    return {
      text: '',
      language: data.language,
      durationSeconds: 0,
      costUsd: 0,
      source: 'no_speech',
    };
  }

  console.log(`Groq success: ${transcript.length} chars, ${duration.toFixed(2)}s, lang=${data.language}, formData=${formDataMs.toFixed(0)}ms, fetch=${fetchMs.toFixed(0)}ms`);

  return {
    text: transcript,
    language: data.language,
    durationSeconds: duration,
    costUsd: computeGroqTranscriptionCost(duration),
    source: 'groq',
  };
}
