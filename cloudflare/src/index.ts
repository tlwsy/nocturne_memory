import type { AppEnv } from "./env";
import { api, apiError } from "./api";
import { isAuthorized, isPublicPath, unauthorized } from "./auth";
import { jsonOk } from "./http";
import { handleMcp } from "./mcp";
import { namespaceFromRequest } from "./uri";

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Namespace, Accept, Mcp-Session-Id",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    Vary: "Origin",
  };
}

function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function apiRequestWithoutPrefix(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api/, "") || "/";
  return new Request(url, request);
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

      if (url.pathname === "/health" || url.pathname === "/api/health") {
        return withCors(
          jsonOk({
            ok: true,
            runtime: "cloudflare-workers",
            date: new Date().toISOString(),
            d1: Boolean(env.DB),
            r2: Boolean(env.ATTACHMENTS),
          }),
          request,
        );
      }

      const protectedPath = url.pathname.startsWith("/api/") || url.pathname === "/mcp";
      if (protectedPath && !isPublicPath(url.pathname) && !(await isAuthorized(request, env))) {
        return withCors(unauthorized(), request);
      }

      let response: Response;
      if (url.pathname === "/mcp") {
        response = await handleMcp(request, env, ctx, namespaceFromRequest(request));
      } else if (url.pathname.startsWith("/api/")) {
        response = await api.fetch(apiRequestWithoutPrefix(request), env, ctx);
      } else if (env.ASSETS) {
        response = await env.ASSETS.fetch(request);
      } else {
        response = jsonOk({ ok: true, runtime: "cloudflare-workers", message: "No static assets binding available in this environment." });
      }

      console.log(
        JSON.stringify({
          level: "info",
          event: "request",
          method: request.method,
          path: url.pathname,
          status: response.status,
          duration_ms: Date.now() - started,
        }),
      );
      return withCors(response, request);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_error",
          method: request.method,
          path: url.pathname,
          duration_ms: Date.now() - started,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return withCors(apiError(error), request);
    }
  },
};
