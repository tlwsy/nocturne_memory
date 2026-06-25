import type { AppEnv } from "./env";

const encoder = new TextEncoder();

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export function isPublicPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/api/health";
}

export async function isAuthorized(request: Request, env: AppEnv): Promise<boolean> {
  const expected = env.API_TOKEN;
  const actual = bearerToken(request);
  if (!expected || !actual) return false;
  const expectedBytes = encoder.encode(expected);
  const actualBytes = encoder.encode(actual);
  const expectedDigest = await crypto.subtle.digest("SHA-256", expectedBytes);
  const actualDigest = await crypto.subtle.digest("SHA-256", actualBytes);
  return constantTimeBytesEqual(new Uint8Array(expectedDigest), new Uint8Array(actualDigest));
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}
