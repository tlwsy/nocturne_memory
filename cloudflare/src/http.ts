export function jsonOk<T>(data: T, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function jsonError(message: string, status = 400, detail?: string): Response {
  return jsonOk({ error: message, detail }, { status });
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
