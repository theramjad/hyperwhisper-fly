// TRANSCRIPTION ROUTE
// POST /transcribe - Main transcription endpoint
// Supports multiple STT providers with automatic fallback

import type { Context } from 'hono';
import { transcribeWithDeepgram, type TranscriptionResult } from '../providers/deepgram';
import { transcribeWithGroq, GroqEdgeBlockedError } from '../providers/groq';
import { transcribeWithElevenLabs } from '../providers/elevenlabs';
import { deductCredits, usdToCredits } from '../middleware/credits';

type Provider = 'deepgram' | 'groq' | 'elevenlabs';

export async function transcribeRoute(c: Context) {
  const startTime = Date.now();

  // Get provider from header (default: deepgram)
  const provider = (c.req.header('X-STT-Provider') || 'deepgram').toLowerCase() as Provider;

  // Get transcription options from query params
  const language = c.req.query('language');
  const initialPrompt = c.req.query('initial_prompt');

  // Buffer entire request body (Fly.io can handle larger files than Workers)
  const audioBuffer = await c.req.arrayBuffer();
  const contentType = c.req.header('Content-Type') || 'audio/wav';

  console.log(`Transcribe request: provider=${provider}, size=${audioBuffer.byteLength}, type=${contentType}`);

  let result: TranscriptionResult;
  let actualProvider = provider;
  let fallbackFrom: string | undefined;

  try {
    if (provider === 'groq') {
      try {
        result = await transcribeWithGroq(audioBuffer, contentType, language, initialPrompt);
      } catch (error) {
        // Groq 403 edge blocking - fallback to Deepgram
        if (error instanceof GroqEdgeBlockedError) {
          console.warn('Groq 403 - falling back to Deepgram');
          result = await transcribeWithDeepgram(audioBuffer, contentType, language, initialPrompt);
          actualProvider = 'deepgram';
          fallbackFrom = 'groq';
        } else {
          throw error;
        }
      }
    } else if (provider === 'elevenlabs') {
      result = await transcribeWithElevenLabs(audioBuffer, contentType, language, initialPrompt);
    } else {
      // Default: Deepgram
      result = await transcribeWithDeepgram(audioBuffer, contentType, language, initialPrompt);
    }
  } catch (error) {
    console.error('Transcription failed:', error);

    return c.json({
      error: 'Transcription failed',
      message: error instanceof Error ? error.message : String(error),
    }, 500);
  }

  // Deduct credits (non-blocking)
  const auth = c.get('auth');
  deductCredits(auth, result.costUsd).catch(console.error);

  // Build provider name with fallback info
  const providerName = fallbackFrom
    ? `${actualProvider} (fallback from ${fallbackFrom})`
    : actualProvider;

  const processingTime = Date.now() - startTime;

  // Calculate remaining credits
  const creditsUsed = usdToCredits(result.costUsd);
  const creditsRemaining = auth.credits !== undefined ? auth.credits - creditsUsed : undefined;

  // Build response
  const response = {
    text: result.text,
    language: result.language,
    duration: result.durationSeconds,
    cost: {
      usd: result.costUsd,
      credits: creditsUsed,
    },
    metadata: {
      stt_provider: providerName,
      region: process.env.FLY_REGION || 'local',
      processing_time_ms: processingTime,
    },
  };

  // Add response headers
  c.header('X-STT-Provider', providerName);
  c.header('X-Fly-Region', process.env.FLY_REGION || 'local');
  c.header('X-Credits-Used', String(creditsUsed.toFixed(4)));
  c.header('X-Processing-Time-Ms', String(processingTime));

  if (creditsRemaining !== undefined) {
    c.header('X-Credits-Remaining', String(creditsRemaining.toFixed(4)));
  }

  console.log(`Transcribe complete: ${result.text.length} chars, ${result.durationSeconds.toFixed(2)}s, $${result.costUsd.toFixed(6)}, ${processingTime}ms`);

  return c.json(response);
}
