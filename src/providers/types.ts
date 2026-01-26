export type TranscriptionSource = 'deepgram' | 'elevenlabs' | 'groq' | 'no_speech';

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds: number;
  costUsd: number;
  source: TranscriptionSource;
  requestId?: string;
}
