// COST CALCULATION MODULE
// Handles pricing calculations for STT providers and LLM post-processing

import { roundToTenth, roundUpToTenth } from './utils';

// =============================================================================
// PRICING CONSTANTS
// =============================================================================

// ElevenLabs Scribe v2 Pricing (USD)
const ELEVENLABS_COST_PER_AUDIO_MINUTE = 0.00983;

// Deepgram Nova-3 Pricing (USD)
// Base $0.0043 + features $0.0012
const DEEPGRAM_COST_PER_AUDIO_MINUTE = 0.0055;

// Groq Whisper Pricing (USD)
const GROQ_WHISPER_COST_PER_AUDIO_HOUR = 0.111; // $0.111/hour
const GROQ_WHISPER_MIN_BILLABLE_SECONDS = 10;

// Cerebras Llama Pricing (USD)
const CEREBRAS_PROMPT_COST_PER_TOKEN = 0.85 / 1_000_000;
const CEREBRAS_COMPLETION_COST_PER_TOKEN = 1.20 / 1_000_000;

// Groq Llama Pricing (USD)
const GROQ_PROMPT_COST_PER_TOKEN = 0.59 / 1_000_000;
const GROQ_COMPLETION_COST_PER_TOKEN = 0.79 / 1_000_000;

// Credit model: 1 credit = $0.001
const USD_PER_CREDIT = 0.001;

// =============================================================================
// TYPES
// =============================================================================

export interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// =============================================================================
// STT COSTS
// =============================================================================

export function computeElevenLabsTranscriptionCost(durationSeconds: number): number {
  const durationMinutes = durationSeconds / 60;
  const raw = durationMinutes * ELEVENLABS_COST_PER_AUDIO_MINUTE;
  return roundUsd(raw);
}

export function computeDeepgramTranscriptionCost(durationSeconds: number): number {
  const durationMinutes = durationSeconds / 60;
  const raw = durationMinutes * DEEPGRAM_COST_PER_AUDIO_MINUTE;
  return roundUsd(raw);
}

export function computeGroqTranscriptionCost(durationSeconds: number): number {
  const billableSeconds = Math.max(durationSeconds, GROQ_WHISPER_MIN_BILLABLE_SECONDS);
  const raw = (billableSeconds / 3600) * GROQ_WHISPER_COST_PER_AUDIO_HOUR;
  return roundUsd(raw);
}

// =============================================================================
// LLM COSTS
// =============================================================================

export function computeCerebrasChatCost(usage: GroqUsage): number {
  const promptCost = usage.prompt_tokens * CEREBRAS_PROMPT_COST_PER_TOKEN;
  const completionCost = usage.completion_tokens * CEREBRAS_COMPLETION_COST_PER_TOKEN;
  return roundUsd(promptCost + completionCost);
}

export function computeGroqChatCost(usage: GroqUsage): number {
  const promptCost = usage.prompt_tokens * GROQ_PROMPT_COST_PER_TOKEN;
  const completionCost = usage.completion_tokens * GROQ_COMPLETION_COST_PER_TOKEN;
  return roundUsd(promptCost + completionCost);
}

export function isGroqUsage(value: unknown): value is GroqUsage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const usage = value as GroqUsage;
  return typeof usage.prompt_tokens === 'number'
    && typeof usage.completion_tokens === 'number'
    && typeof usage.total_tokens === 'number';
}

// =============================================================================
// CREDITS + FORMATTING
// =============================================================================

export function usdToCredits(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) {
    return 0;
  }

  if (USD_PER_CREDIT <= 0) {
    return Math.max(0.1, roundUpToTenth(usd * 1000));
  }

  return usd / USD_PER_CREDIT;
}

export function creditsForCost(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    return 0;
  }

  const rawCredits = usdToCredits(costUsd);
  return Math.max(0.1, roundToTenth(rawCredits));
}

export function estimateCreditsForCost(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    return 0;
  }

  const rawCredits = usdToCredits(costUsd);
  return Math.max(0.1, roundUpToTenth(rawCredits));
}

export function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function formatUsd(value: number): string {
  return roundUsd(value).toFixed(6);
}
