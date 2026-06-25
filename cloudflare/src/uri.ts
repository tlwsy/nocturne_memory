const DOMAIN_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SEGMENT_RE = /^[^/?#\s]+$/;

export type MemoryUri = {
  domain: string;
  path: string;
};

export function normalizePath(path: string | null | undefined): string {
  return (path ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
}

export function parseMemoryUri(uri: string): MemoryUri {
  const match = /^([a-zA-Z][a-zA-Z0-9_-]{0,63}):\/\/(.*)$/.exec(uri.trim());
  if (!match) throw new Error(`Invalid memory URI: ${uri}`);
  const domain = match[1]!.toLowerCase();
  const path = normalizePath(match[2]);
  if (!DOMAIN_RE.test(domain)) throw new Error(`Invalid domain: ${domain}`);
  if (path.length > 512) throw new Error("Path is too long");
  for (const segment of path.split("/").filter(Boolean)) {
    if (!SEGMENT_RE.test(segment)) throw new Error(`Invalid path segment: ${segment}`);
  }
  return { domain, path };
}

export function makeUri(domain: string, path: string): string {
  return `${domain}://${normalizePath(path)}`;
}

export function parentPath(path: string): string {
  const clean = normalizePath(path);
  if (!clean) return "";
  const parts = clean.split("/");
  parts.pop();
  return parts.join("/");
}

export function leafName(path: string): string {
  const clean = normalizePath(path);
  if (!clean) return "";
  return clean.split("/").at(-1) ?? "";
}

export function joinPath(parent: string, child: string): string {
  const name = normalizePath(child);
  if (!name || name.includes("/")) throw new Error("Title/path segment must be a single non-empty segment");
  const p = normalizePath(parent);
  return p ? `${p}/${name}` : name;
}

export function namespaceFromRequest(request: Request): string {
  const url = new URL(request.url);
  const header = request.headers.get("X-Namespace");
  const ns = (header ?? url.searchParams.get("namespace") ?? "").trim();
  if (ns.length > 64) throw new Error("Namespace is too long");
  return ns;
}
