import { ProviderUnavailableError } from './types';
import type { ProviderRequestContext } from './types';

const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const ERROR_BODY_PREVIEW_LIMIT = 500;

function resolveProviderTimeoutMs(): number {
  const configured = Number.parseInt(process.env.STT_PROVIDER_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_PROVIDER_TIMEOUT_MS;
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function logProviderEvent(
  provider: string,
  event: string,
  details: Record<string, unknown>,
  context: ProviderRequestContext = {},
) {
  console.log(`provider.${event}`, {
    provider,
    requestId: context.requestId,
    attempt: context.attempt,
    ...details,
  });
}

export async function fetchWithTimeout(
  provider: string,
  url: string,
  init: RequestInit,
  context: ProviderRequestContext = {},
): Promise<Response> {
  const timeoutMs = resolveProviderTimeoutMs();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  logProviderEvent(provider, 'request_start', { timeoutMs }, context);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    logProviderEvent(provider, 'http_response', {
      elapsedMs: Math.round(performance.now() - startedAt),
      status: response.status,
      ok: response.ok,
    }, context);

    return response;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);

    if (isAbortError(error)) {
      logProviderEvent(provider, 'transport_error', {
        elapsedMs,
        kind: 'timeout',
        timeoutMs,
      }, context);
      throw new ProviderUnavailableError(provider, `timeout after ${timeoutMs}ms`);
    }

    logProviderEvent(provider, 'transport_error', {
      elapsedMs,
      kind: 'network_error',
      message: serializeError(error),
    }, context);
    throw new ProviderUnavailableError(provider, `network error: ${serializeError(error)}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function readErrorBodyPreview(response: Response): Promise<string> {
  try {
    const body = await response.text();
    if (body.length <= ERROR_BODY_PREVIEW_LIMIT) {
      return body;
    }

    return `${body.slice(0, ERROR_BODY_PREVIEW_LIMIT)}...`;
  } catch {
    return '<unreadable>';
  }
}
