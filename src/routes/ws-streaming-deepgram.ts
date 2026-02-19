// WEBSOCKET STREAMING ROUTE
// GET /ws/streaming-deepgram - Deepgram Live proxy

import type { Context, Next } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { generateRequestId } from '../lib/request-id';
import { computeDeepgramTranscriptionCost, creditsForCost } from '../lib/cost-calculator';
import { validateAuth, type AuthContext } from '../middleware/auth';
import { deductCredits } from '../middleware/credits';
import { isIPBlocked } from '../lib/redis';

interface DeepgramLiveResponse {
  type: string;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
  };
}

interface ReadyMessage {
  type: 'ready';
  sessionId: string;
}

interface TranscriptMessage {
  type: 'transcript';
  text: string;
  is_final: boolean;
  speech_final: boolean;
}

interface SessionCompleteMessage {
  type: 'session_complete';
  duration_seconds: number;
  credits_used: number;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type ServerMessage = ReadyMessage | TranscriptMessage | SessionCompleteMessage | ErrorMessage;

interface WSContext {
  readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

declare module 'hono' {
  interface ContextVariableMap {
    wsAuth: AuthContext;
    wsClientIP: string;
  }
}

function getClientIP(c: Context): string {
  return c.req.header('Fly-Client-IP')
    || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

function sendToClient(socket: WSContext, message: ServerMessage): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function buildDeepgramUrl(language?: string, vocabulary?: string): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    interim_results: 'true',
    punctuate: 'true',
    endpointing: '300',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });

  if (language && language !== 'auto') {
    params.set('language', language);
    if (vocabulary) {
      const terms = vocabulary.split(',').map(t => t.trim()).filter(Boolean);
      if (terms.length > 0 && terms.length <= 100) {
        const keyterms = terms.map(term => `${term}:1.5`).join(',');
        params.set('keyterm', keyterms);
      }
    }
  }

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

export async function wsStreamingPreflight(c: Context, next: Next) {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const clientIP = getClientIP(c);
  if (await isIPBlocked(clientIP)) {
    return c.text('Access denied', 403);
  }

  const url = new URL(c.req.url);
  const licenseKey = url.searchParams.get('license_key') || undefined;
  const deviceId = url.searchParams.get('device_id') || undefined;

  if (!licenseKey && !deviceId) {
    return c.text('Missing license_key or device_id', 401);
  }

  const authResult = await validateAuth({ licenseKey, deviceId });
  if (!authResult.ok) {
    return c.text('Unauthorized', 401);
  }

  c.set('wsAuth', authResult.value);
  c.set('wsClientIP', clientIP);

  return next();
}

export const wsStreamingRoute = upgradeWebSocket((c) => {
  const requestId = generateRequestId();
  const auth = c.get('wsAuth');
  const clientIP = c.get('wsClientIP');
  const url = new URL(c.req.url);
  const language = url.searchParams.get('language') || undefined;
  const vocabulary = url.searchParams.get('vocabulary') || undefined;
  const apiKey = process.env.DEEPGRAM_API_KEY || '';

  let totalDurationSeconds = 0;
  let deepgramWs: WebSocket | null = null;
  let sessionEnded = false;
  let clientSocket: WSContext | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const dgUrl = buildDeepgramUrl(language, vocabulary);

  async function endSession(): Promise<void> {
    if (sessionEnded) return;
    sessionEnded = true;

    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }

    const costUsd = computeDeepgramTranscriptionCost(totalDurationSeconds);
    const creditsUsed = creditsForCost(costUsd);

    if (clientSocket) {
      sendToClient(clientSocket, {
        type: 'session_complete',
        duration_seconds: totalDurationSeconds,
        credits_used: creditsUsed,
      });
    }

    if (creditsUsed > 0) {
      deductCredits(
        auth,
        costUsd,
        {
          audio_duration_seconds: totalDurationSeconds,
          transcription_cost_usd: costUsd,
          language: language || 'auto',
          endpoint: '/ws/streaming-deepgram',
          stt_provider: 'deepgram-nova3-live',
        },
        clientIP
      ).catch(console.error);
    }
  }

  return {
    onOpen: (_evt, ws) => {
      clientSocket = ws;

      if (!apiKey) {
        sendToClient(ws, { type: 'error', message: 'Deepgram API key not configured' });
        ws.close(1011, 'Configuration error');
        return;
      }

      deepgramWs = new WebSocket(dgUrl, ['token', apiKey]);

      deepgramWs.addEventListener('open', () => {
        sendToClient(ws, { type: 'ready', sessionId: requestId });
      });

      deepgramWs.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data as string) as DeepgramLiveResponse;
          if (data.type === 'Results') {
            if (data.duration) {
              totalDurationSeconds += data.duration;
            }
            const transcript = data.channel?.alternatives?.[0]?.transcript || '';
            if (transcript || data.is_final) {
              sendToClient(ws, {
                type: 'transcript',
                text: transcript,
                is_final: data.is_final ?? false,
                speech_final: data.speech_final ?? false,
              });
            }
          }
        } catch (error) {
          console.warn('Failed to parse Deepgram message', error);
        }
      });

      deepgramWs.addEventListener('error', () => {
        sendToClient(ws, { type: 'error', message: 'Transcription service error' });
      });

      deepgramWs.addEventListener('close', async () => {
        await endSession();
        if (ws.readyState === 1) {
          ws.close(1000, 'Session ended');
        }
      });

      // Send ping every 30s to prevent Fly.io's 60s idle timeout from killing the connection
      pingInterval = setInterval(() => {
        if (clientSocket && clientSocket.readyState === 1) {
          clientSocket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    },
    onMessage: (event) => {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
        return;
      }

      const data = event.data;
      if (data instanceof ArrayBuffer) {
        deepgramWs.send(data);
        return;
      }

      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data) as { type?: string };
          if (msg.type === 'stop') {
            deepgramWs.close(1000, 'Client requested stop');
            return;
          }
          if (msg.type === 'pong') {
            // Client pong response — ignore
            return;
          }
        } catch {
          // ignore non-JSON text messages
        }
      }
    },
    onClose: async () => {
      await endSession();
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close(1000, 'Client disconnected');
      }
    },
    onError: () => {
      if (clientSocket) {
        sendToClient(clientSocket, { type: 'error', message: 'WebSocket error' });
      }
    },
  };
});
