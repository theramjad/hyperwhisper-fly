// POST-PROCESS ROUTE
// POST /post-process - standalone text correction via LLM

import type { Context } from 'hono';
import { extractLLMProvider, LLM_PROVIDER_NAMES, callWithRetry, shouldFallback, type LLMProvider } from '../lib/llm-provider';
import { generateRequestId } from '../lib/request-id';
import { buildTranscriptUserContent, containsPromptLeakage, extractCorrectedText, stripCleanMarkers } from '../lib/text-processing';
import { buildCorrectionRequest } from '../providers/groq-llm';
import { creditsForCost, formatUsd } from '../lib/cost-calculator';
import { isIPBlocked } from '../lib/redis';
import { errorResponse, invalidContentTypeResponse } from '../lib/responses';
import { validateAuth } from '../middleware/auth';
import { deductCredits, validateCredits } from '../middleware/credits';
import { logEvent } from '../lib/logging';

const MAX_TEXT_LENGTH = 100000;
const ESTIMATED_POST_PROCESS_CREDITS = 1.0;


interface PostProcessBody {
  text?: string;
  prompt?: string;
  license_key?: string;
  device_id?: string;
}

function getClientIP(c: Context): string {
  return c.req.header('Fly-Client-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

export async function postProcessRoute(c: Context) {
  const requestId = generateRequestId();
  const startTime = performance.now();
  const clientIP = getClientIP(c);

  if (await isIPBlocked(clientIP)) {
    logEvent(requestId, startTime, 'post_process.request_rejected', { reason: 'ip_blocked' });
    return errorResponse(403, 'Access denied', 'Your IP has been temporarily blocked due to abuse');
  }
  logEvent(requestId, startTime, 'post_process.ip_check_done');

  const contentType = c.req.header('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return invalidContentTypeResponse('application/json', contentType);
  }

  let body: PostProcessBody;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(400, 'Invalid JSON', 'Request body must be valid JSON');
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return errorResponse(400, 'Missing field', 'Request body must include "text" field');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return errorResponse(400, 'Text too long', `Text must be ${MAX_TEXT_LENGTH} characters or less`, {
      max_length: MAX_TEXT_LENGTH,
      actual_length: text.length,
    });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return errorResponse(400, 'Missing field', 'Request body must include "prompt" field');
  }

  const provider = extractLLMProvider(c.req.raw);

  logEvent(requestId, startTime, 'post_process.request_start', {
    flyRegion: process.env.FLY_REGION || 'local',
    provider,
    inputChars: text.length,
    promptChars: prompt.length,
  });

  const authResult = await validateAuth({
    licenseKey: body.license_key,
    deviceId: body.device_id,
  });
  if (!authResult.ok) {
    logEvent(requestId, startTime, 'post_process.request_rejected', { reason: 'auth_failed' });
    return authResult.response;
  }
  logEvent(requestId, startTime, 'post_process.auth_done');

  const creditCheck = await validateCredits(authResult.value, ESTIMATED_POST_PROCESS_CREDITS, clientIP);
  if (!creditCheck.ok) {
    logEvent(requestId, startTime, 'post_process.request_rejected', { reason: 'insufficient_credits' });
    return creditCheck.response;
  }
  logEvent(requestId, startTime, 'post_process.credits_done');

  let providerUsed: LLMProvider = provider;

  const userContent = buildTranscriptUserContent(text);
  const payload = buildCorrectionRequest(prompt, userContent);

  let llmResponse: Awaited<ReturnType<typeof callWithRetry>>;

  logEvent(requestId, startTime, 'post_process.llm_attempt_start', { provider, attempt: 1 });

  try {
    const primaryRetries = provider === 'cerebras' ? 0 : 3;
    llmResponse = await callWithRetry(provider, payload, requestId, primaryRetries);
  } catch (error) {
    logEvent(requestId, startTime, 'post_process.llm_attempt_fail', {
      provider,
      attempt: 1,
      error: error instanceof Error ? error.message : String(error),
    });

    if (shouldFallback(error)) {
      providerUsed = provider === 'cerebras' ? 'groq' : 'cerebras';
      const fallbackRetries = providerUsed === 'groq' ? 3 : 0;

      logEvent(requestId, startTime, 'post_process.llm_fallback_start', { provider: providerUsed });

      try {
        llmResponse = await callWithRetry(providerUsed, payload, requestId, fallbackRetries);
      } catch (fallbackError) {
        logEvent(requestId, startTime, 'post_process.request_fail', {
          reason: 'llm_fallback_failed',
          provider: providerUsed,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return errorResponse(500, 'Post-processing failed', fallbackError instanceof Error ? fallbackError.message : String(fallbackError), { requestId });
      }
    } else {
      logEvent(requestId, startTime, 'post_process.request_fail', {
        reason: 'llm_failed_no_fallback',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(500, 'Post-processing failed', error instanceof Error ? error.message : String(error), { requestId });
    }
  }

  logEvent(requestId, startTime, 'post_process.llm_attempt_done', {
    provider: providerUsed,
    outputChars: llmResponse.raw.length,
    costUsd: llmResponse.costUsd,
  });

  let correctedText = stripCleanMarkers(extractCorrectedText(llmResponse.raw));
  let costUsd = llmResponse.costUsd;

  if (containsPromptLeakage(correctedText)) {
    logEvent(requestId, startTime, 'post_process.prompt_leakage_detected', {
      provider: providerUsed,
      inputChars: text.length,
      outputChars: correctedText.length,
    });

    const alternateProvider: LLMProvider = providerUsed === 'cerebras' ? 'groq' : 'cerebras';
    const alternateRetries = alternateProvider === 'groq' ? 3 : 0;

    logEvent(requestId, startTime, 'post_process.llm_leakage_retry_start', { provider: alternateProvider });

    try {
      const retryResponse = await callWithRetry(alternateProvider, payload, requestId, alternateRetries);
      const retryText = stripCleanMarkers(extractCorrectedText(retryResponse.raw));

      if (containsPromptLeakage(retryText)) {
        logEvent(requestId, startTime, 'post_process.prompt_leakage_persisted', {
          provider: alternateProvider,
          fallbackToRaw: true,
        });
        correctedText = text;
        providerUsed = alternateProvider;
        costUsd += retryResponse.costUsd;
      } else {
        correctedText = retryText;
        providerUsed = alternateProvider;
        costUsd += retryResponse.costUsd;
      }
    } catch (retryError) {
      logEvent(requestId, startTime, 'post_process.llm_leakage_retry_fail', {
        provider: alternateProvider,
        error: retryError instanceof Error ? retryError.message : String(retryError),
        fallbackToRaw: true,
      });
      correctedText = text;
    }
  }

  const creditsUsed = creditsForCost(costUsd);

  deductCredits(
    authResult.value,
    costUsd,
    {
      post_processing_cost_usd: costUsd,
      input_length: text.length,
      output_length: correctedText.length,
      endpoint: '/post-process',
      llm_provider: providerUsed,
    },
    clientIP
  ).catch(console.error);

  logEvent(requestId, startTime, 'post_process.request_done', {
    finalProvider: LLM_PROVIDER_NAMES[providerUsed],
    inputChars: text.length,
    outputChars: correctedText.length,
    costUsd,
    creditsUsed,
    hadLeakage: correctedText === text && text.length > 0,
  });

  const response = {
    corrected: correctedText,
    cost: {
      usd: costUsd,
      credits: creditsUsed,
    },
  };

  c.header('X-Request-ID', requestId);
  c.header('X-LLM-Provider', LLM_PROVIDER_NAMES[providerUsed]);
  c.header('X-Total-Cost-Usd', formatUsd(costUsd));
  c.header('X-Credits-Used', creditsUsed.toFixed(1));

  return c.json(response);
}
