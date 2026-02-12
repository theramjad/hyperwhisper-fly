// GROQ LLM CLIENT (CHAT COMPLETIONS)

import { computeGroqChatCost, isGroqUsage, type GroqUsage } from '../lib/cost-calculator';
import { isRecord, safeReadText } from '../lib/utils';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_CHAT_MODEL = 'openai/gpt-oss-120b';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export type CorrectionRequestPayload = {
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
};

export async function requestGroqChat(
  payload: CorrectionRequestPayload,
  requestId: string
): Promise<{ raw: unknown; usage?: GroqUsage; costUsd: number }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const chatUrl = `${GROQ_BASE_URL}/chat/completions`;

  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      ...payload,
      reasoning_effort: 'low',
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    console.error('Groq LLM API returned error', {
      requestId,
      status: response.status,
      statusText: response.statusText,
      errorText,
    });
    const error = new Error(`Groq chat failed with status ${response.status}`);
    (error as { status?: number; provider?: string }).status = response.status;
    (error as { provider?: string }).provider = 'groq';
    throw error;
  }

  const json = await response.json();
  const usage = isRecord(json) && isGroqUsage(json['usage']) ? (json['usage'] as GroqUsage) : undefined;
  const costUsd = usage ? computeGroqChatCost(usage) : 0;

  return {
    raw: json,
    usage,
    costUsd,
  };
}

export function buildCorrectionRequest(systemPrompt: string, userContent: string): CorrectionRequestPayload {
  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    max_tokens: 32768,
  };
}
