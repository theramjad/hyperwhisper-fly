// ANTHROPIC VISION LLM CLIENT (MESSAGES API, STREAMING)
// Used by the /assistant endpoint for screen-aware AI responses.

import { computeAnthropicCost } from '../lib/cost-calculator';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

export interface AnthropicContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicStreamResult {
  stream: ReadableStream<Uint8Array>;
  costPromise: Promise<number>;
}

/**
 * Calls the Anthropic Messages API with streaming enabled.
 * Returns a ReadableStream that emits OpenAI-compatible SSE chunks,
 * and a promise that resolves to the total cost in USD after the stream completes.
 */
export function streamAnthropicChat(
  systemPrompt: string,
  messages: AnthropicMessage[],
  requestId: string
): AnthropicStreamResult {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  let resolveCost: (cost: number) => void;
  const costPromise = new Promise<number>((resolve) => {
    resolveCost = resolve;
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: MAX_TOKENS,
            system: systemPrompt,
            messages,
            stream: true,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          console.error(`[${requestId}] Anthropic API error: ${response.status} ${errorText.slice(0, 500)}`);
          const errorChunk = JSON.stringify({
            choices: [{ delta: { content: '' }, finish_reason: 'error' }],
            error: `Anthropic API error: ${response.status}`,
          });
          controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          resolveCost(0);
          return;
        }

        const body = response.body;
        if (!body) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          resolveCost(0);
          return;
        }

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);

              // Track usage from message_start
              if (event.type === 'message_start' && event.message?.usage) {
                inputTokens = event.message.usage.input_tokens || 0;
              }

              // Emit text deltas as OpenAI-compatible chunks
              if (event.type === 'content_block_delta' && event.delta?.text) {
                const chunk = JSON.stringify({
                  choices: [{ delta: { content: event.delta.text } }],
                });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
              }

              // Track output tokens from message_delta
              if (event.type === 'message_delta' && event.usage) {
                outputTokens = event.usage.output_tokens || 0;
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();

        const costUsd = computeAnthropicCost(inputTokens, outputTokens);
        console.log(`[${requestId}] Anthropic usage: input=${inputTokens}, output=${outputTokens}, cost=$${costUsd.toFixed(6)}`);
        resolveCost(costUsd);
      } catch (error) {
        console.error(`[${requestId}] Anthropic stream error:`, error);
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          // Controller may already be closed
        }
        resolveCost(0);
      }
    },
  });

  return { stream, costPromise };
}
