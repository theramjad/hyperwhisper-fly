// DEEPGRAM NOVA-3 PROVIDER
// Primary STT provider - $0.0043/min, best accuracy with vocabulary boosting

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds: number;
  costUsd: number;
}

// Deepgram Nova-3 pricing: $0.0043 per minute
const DEEPGRAM_COST_PER_MINUTE = 0.0043;

// Maximum keywords Deepgram accepts
const MAX_KEYWORDS = 100;

/**
 * Convert initial prompt to Deepgram keyterm format
 * Input: "HyperWhisper,SwiftUI,Claude"
 * Output: "HyperWhisper,SwiftUI,Claude" (plain strings for keyterm)
 */
function convertToKeyterms(initialPrompt: string): string {
  const terms = initialPrompt
    .split(/[,\n;]+/)
    .map(t => t.trim().replace(/^[-*]\s*/, ''))
    .filter(t => t.length > 0 && t.length <= 50)
    .slice(0, MAX_KEYWORDS);

  return terms.join(',');
}

/**
 * Build Deepgram API URL with query parameters
 */
function buildDeepgramUrl(language?: string, vocabularyTerms?: string): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    utterances: 'true',
  });

  const isMonolingual = language && language.toLowerCase() !== 'auto';

  if (isMonolingual) {
    params.set('language', language.toLowerCase());
  } else {
    params.set('detect_language', 'true');
  }

  // Keyterm works for Nova-3 in both modes
  if (vocabularyTerms && vocabularyTerms.length > 0) {
    params.set('keyterm', vocabularyTerms);
  }

  return `https://api.deepgram.com/v1/listen?${params.toString()}`;
}

/**
 * Transcribe audio with Deepgram Nova-3
 */
export async function transcribeWithDeepgram(
  audio: ArrayBuffer,
  contentType: string,
  language?: string,
  initialPrompt?: string
): Promise<TranscriptionResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPGRAM_API_KEY not configured');
  }

  const keyterms = initialPrompt ? convertToKeyterms(initialPrompt) : '';
  const url = buildDeepgramUrl(language, keyterms);

  console.log(`Deepgram request: ${audio.byteLength} bytes, language=${language || 'auto'}, keyterms=${keyterms.split(',').length}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': contentType,
    },
    body: audio,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Deepgram error ${response.status}: ${errorText}`);

    if (response.status === 401) {
      throw new Error('Deepgram API key is invalid or expired');
    }
    if (response.status === 402) {
      throw new Error('Deepgram account has insufficient funds');
    }
    if (response.status === 429) {
      throw new Error('Deepgram rate limit exceeded');
    }

    throw new Error(`Deepgram error: ${response.status}`);
  }

  const data = await response.json() as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>;
        detected_language?: string;
      }>;
    };
    metadata?: {
      duration?: number;
      request_id?: string;
    };
  };

  const channel = data.results?.channels?.[0];
  const transcript = channel?.alternatives?.[0]?.transcript || '';
  const duration = data.metadata?.duration || 0;

  console.log(`Deepgram success: ${transcript.length} chars, ${duration.toFixed(2)}s, lang=${channel?.detected_language}`);

  return {
    text: transcript,
    language: channel?.detected_language,
    durationSeconds: duration,
    costUsd: (duration / 60) * DEEPGRAM_COST_PER_MINUTE,
  };
}
