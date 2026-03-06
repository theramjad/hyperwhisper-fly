export function logEvent(
  requestId: string,
  startTime: number,
  event: string,
  details: Record<string, unknown> = {},
) {
  console.log(event, {
    requestId,
    elapsedMs: Math.round(performance.now() - startTime),
    ...details,
  });
}
