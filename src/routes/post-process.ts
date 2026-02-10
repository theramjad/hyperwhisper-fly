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
  const clientIP = getClientIP(c);

  if (await isIPBlocked(clientIP)) {
    return errorResponse(403, 'Access denied', 'Your IP has been temporarily blocked due to abuse');
  }

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

  const authResult = await validateAuth({
    licenseKey: body.license_key,
    deviceId: body.device_id,
  });
  if (!authResult.ok) {
    return authResult.response;
  }

  const creditCheck = await validateCredits(authResult.value, ESTIMATED_POST_PROCESS_CREDITS, clientIP);
  if (!creditCheck.ok) {
    return creditCheck.response;
  }

  const provider = extractLLMProvider(c.req.raw);
  let providerUsed: LLMProvider = provider;

  const userContent = buildTranscriptUserContent(text);
  const payload = buildCorrectionRequest(prompt, userContent);

  let llmResponse: Awaited<ReturnType<typeof callWithRetry>>;

  try {
    const primaryRetries = provider === 'cerebras' ? 0 : 3;
    llmResponse = await callWithRetry(provider, payload, requestId, primaryRetries);
  } catch (error) {
    if (shouldFallback(error)) {
      providerUsed = provider === 'cerebras' ? 'groq' : 'cerebras';
      const fallbackRetries = providerUsed === 'groq' ? 3 : 0;
      llmResponse = await callWithRetry(providerUsed, payload, requestId, fallbackRetries);
    } else {
      return errorResponse(500, 'Post-processing failed', error instanceof Error ? error.message : String(error), { requestId });
    }
  }

  let correctedText = stripCleanMarkers(extractCorrectedText(llmResponse.raw));
  let costUsd = llmResponse.costUsd;

  if (containsPromptLeakage(correctedText)) {
    console.warn(`[${requestId}] Prompt leakage detected from ${providerUsed} (input=${text.length}, output=${correctedText.length}), retrying with alternate provider`);

    const alternateProvider: LLMProvider = providerUsed === 'cerebras' ? 'groq' : 'cerebras';
    const alternateRetries = alternateProvider === 'groq' ? 3 : 0;

    try {
      const retryResponse = await callWithRetry(alternateProvider, payload, requestId, alternateRetries);
      const retryText = stripCleanMarkers(extractCorrectedText(retryResponse.raw));

      if (containsPromptLeakage(retryText)) {
        console.warn(`[${requestId}] Prompt leakage persists from ${alternateProvider}, falling back to raw text`);
        correctedText = text;
        providerUsed = alternateProvider;
        costUsd += retryResponse.costUsd;
      } else {
        correctedText = retryText;
        providerUsed = alternateProvider;
        costUsd += retryResponse.costUsd;
      }
    } catch (retryError) {
      console.warn(`[${requestId}] Alternate provider ${alternateProvider} failed after leakage, falling back to raw text:`, retryError);
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
