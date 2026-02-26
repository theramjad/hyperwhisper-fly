// ASSISTANT ROUTE
// POST /assistant - vision LLM for screen-aware AI assistant mode
// Accepts multipart/form-data with screenshot + conversation messages
// Streams response as SSE (OpenAI-compatible delta format)

import type { Context } from 'hono';
import { generateRequestId } from '../lib/request-id';
import { creditsForCost } from '../lib/cost-calculator';
import { isIPBlocked } from '../lib/redis';
import { errorResponse, CORS_HEADERS } from '../lib/responses';
import { validateAuth } from '../middleware/auth';
import { deductCredits, validateCredits } from '../middleware/credits';
import { streamAnthropicChat, type AnthropicContentBlock, type AnthropicMessage } from '../providers/anthropic';

// Estimated credits for upfront validation (vision requests are more expensive)
const ESTIMATED_ASSISTANT_CREDITS = 3.0;

function getClientIP(c: Context): string {
  return c.req.header('Fly-Client-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

/**
 * Convert the client's OpenAI-format messages to Anthropic Messages API format.
 * - Extracts the system message (returned separately for Anthropic's `system` param)
 * - Converts image_url content blocks to Anthropic image blocks
 */
function convertMessages(
  clientMessages: unknown[],
  imageBase64: string | null
): { systemPrompt: string; messages: AnthropicMessage[] } {
  let systemPrompt = '';
  const messages: AnthropicMessage[] = [];

  for (const msg of clientMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string;

    if (role === 'system') {
      systemPrompt = typeof m.content === 'string' ? m.content : '';
      continue;
    }

    if (role !== 'user' && role !== 'assistant') continue;

    // Handle string content
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }

    // Handle array content (multimodal — image_url + text)
    if (Array.isArray(m.content)) {
      const blocks: AnthropicContentBlock[] = [];

      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;

        if (p.type === 'text' && typeof p.text === 'string') {
          blocks.push({ type: 'text', text: p.text });
        }

        if (p.type === 'image_url') {
          // The client embeds base64 inline as data:image/jpeg;base64,...
          // But for HyperWhisper Cloud, the image comes as a separate multipart file
          // We use the multipart image if available, otherwise parse inline
          let base64Data = imageBase64;
          let mediaType = 'image/jpeg';

          if (!base64Data && p.image_url && typeof p.image_url === 'object') {
            const urlObj = p.image_url as Record<string, unknown>;
            const url = urlObj.url as string;
            if (url?.startsWith('data:')) {
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (match) {
                mediaType = match[1];
                base64Data = match[2];
              }
            }
          }

          if (base64Data) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            });
          }
        }
      }

      if (blocks.length > 0) {
        messages.push({ role, content: blocks });
      }
      continue;
    }
  }

  return { systemPrompt, messages };
}

export async function assistantRoute(c: Context) {
  const requestId = generateRequestId();
  const clientIP = getClientIP(c);

  if (await isIPBlocked(clientIP)) {
    return errorResponse(403, 'Access denied', 'Your IP has been temporarily blocked due to abuse');
  }

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return errorResponse(400, 'Invalid request', 'Request must be multipart/form-data');
  }

  const licenseKey = formData.get('license_key') as string | null;
  const deviceId = formData.get('device_id') as string | null;
  const messagesRaw = formData.get('messages') as string | null;
  const promptOverride = formData.get('prompt') as string | null;
  const imageFile = formData.get('image') as File | null;

  // Validate messages
  if (!messagesRaw) {
    return errorResponse(400, 'Missing field', 'Request must include "messages" field');
  }

  let clientMessages: unknown[];
  try {
    clientMessages = JSON.parse(messagesRaw);
    if (!Array.isArray(clientMessages)) throw new Error('not an array');
  } catch {
    return errorResponse(400, 'Invalid messages', 'Messages must be a valid JSON array');
  }

  // Auth
  const authResult = await validateAuth({ licenseKey: licenseKey || undefined, deviceId: deviceId || undefined });
  if (!authResult.ok) {
    return authResult.response;
  }

  // Credit check
  const creditCheck = await validateCredits(authResult.value, ESTIMATED_ASSISTANT_CREDITS, clientIP);
  if (!creditCheck.ok) {
    return creditCheck.response;
  }

  // Read image as base64
  let imageBase64: string | null = null;
  if (imageFile) {
    const imageBuffer = await imageFile.arrayBuffer();
    imageBase64 = Buffer.from(imageBuffer).toString('base64');
  }

  // Convert messages to Anthropic format
  const { systemPrompt, messages } = convertMessages(clientMessages, imageBase64);

  // Use the prompt override if provided (takes precedence over system message in conversation)
  const finalSystemPrompt = promptOverride || systemPrompt || 'You are a helpful screen-aware assistant.';

  console.log(`[${requestId}] Assistant request: ${messages.length} messages, image=${!!imageBase64}, ip=${clientIP}`);

  // Stream the response
  const { stream, costPromise } = streamAnthropicChat(finalSystemPrompt, messages, requestId);

  // Deduct credits after stream completes (fire-and-forget)
  costPromise.then((costUsd) => {
    if (costUsd > 0) {
      deductCredits(
        authResult.value,
        costUsd,
        {
          assistant_cost_usd: costUsd,
          message_count: messages.length,
          has_image: !!imageBase64,
          endpoint: '/assistant',
          llm_provider: 'anthropic',
        },
        clientIP
      ).catch(console.error);
    }
  }).catch(console.error);

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-ID': requestId,
    },
  });
}
