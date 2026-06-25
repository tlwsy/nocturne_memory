import { Hono } from "hono";
import type { AppEnv } from "./env";
import { asErrorMessage, jsonError } from "./http";
import { MemoryService } from "./memory-service";
import { makeUri, namespaceFromRequest, normalizePath, parseMemoryUri } from "./uri";

type Vars = { namespace: string; service: MemoryService };
export const api = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

api.use("*", async (c, next) => {
  const namespace = namespaceFromRequest(c.req.raw);
  c.set("namespace", namespace);
  c.set("service", new MemoryService(c.env.DB, namespace));
  await next();
});

api.onError((err) => jsonError(err.message, 400));

api.get("/health", (c) => c.json({ ok: true, runtime: "cloudflare-workers", storage: ["d1", "r2"] }));

api.get("/browse/domains", async (c) => c.json({ domains: await c.var.service.validDomains() }));
api.post("/browse/domains", async (c) => {
  const body = await c.req.json<{ domain: string }>();
  return c.json({ domains: await c.var.service.addDomain(body.domain) });
});
api.delete("/browse/domains/:domain", async (c) => c.json({ domains: await c.var.service.deleteDomain(c.req.param("domain")) }));
api.get("/browse/namespaces", async (c) => c.json({ namespaces: await c.var.service.listNamespaces() }));

api.get("/browse/node", async (c) => {
  const domain = c.req.query("domain") || "core";
  const path = c.req.query("path") || "";
  const navOnly = c.req.query("nav_only") === "true";
  return c.json(await c.var.service.getNode(domain, path, navOnly));
});

api.post("/browse/node", async (c) => {
  const body = await c.req.json<{ parent_uri?: string; parent_path?: string; domain?: string; content: string; title?: string; priority?: number; disclosure?: string }>();
  const parentUri = body.parent_uri ?? makeUri(body.domain ?? "core", normalizePath(body.parent_path ?? ""));
  const result = await c.var.service.createMemory(parentUri, body.content, body.priority ?? 0, body.disclosure ?? "", body.title);
  return c.json(result, 201);
});

api.put("/browse/node", async (c) => {
  const body = await c.req.json<{ uri?: string; domain?: string; path?: string; content?: string; old_string?: string; new_string?: string; append?: string; priority?: number; disclosure?: string }>();
  const uri = body.uri ?? makeUri(body.domain ?? c.req.query("domain") ?? "core", normalizePath(body.path ?? c.req.query("path") ?? ""));
  return c.json(await c.var.service.updateMemory(uri, body));
});

api.delete("/browse/node", async (c) => {
  const uri = c.req.query("uri") ?? makeUri(c.req.query("domain") ?? "core", normalizePath(c.req.query("path") ?? ""));
  return c.json(await c.var.service.deleteMemory(uri));
});

api.post("/browse/node/alias", async (c) => {
  const body = await c.req.json<{ source_uri?: string; target_uri?: string; alias_uri?: string; new_uri?: string; priority?: number; disclosure?: string }>();
  const targetUri = body.target_uri ?? body.source_uri ?? "";
  const newUri = body.new_uri ?? body.alias_uri ?? "";
  return c.json(await c.var.service.addAlias(targetUri, newUri, body.priority ?? 0, body.disclosure ?? ""));
});

api.post("/browse/node/rename", async (c) => {
  const body = await c.req.json<{ source_uri?: string; old_uri?: string; new_uri: string; priority?: number; disclosure?: string }>();
  const source = body.source_uri ?? body.old_uri ?? "";
  await c.var.service.addAlias(source, body.new_uri, body.priority ?? 0, body.disclosure ?? "");
  await c.var.service.deleteMemory(source);
  return c.json({ success: true, uri: body.new_uri });
});

api.get("/browse/glossary", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT g.keyword,g.node_uuid,sd.uri
     FROM glossary_keywords g LEFT JOIN search_documents sd ON sd.namespace=g.namespace AND sd.node_uuid=g.node_uuid
     WHERE g.namespace=? ORDER BY g.keyword`,
  ).bind(c.var.namespace).all();
  return c.json({ keywords: rows.results ?? [] });
});

api.post("/browse/glossary", async (c) => {
  const body = await c.req.json<{ keyword: string; node_uuid?: string; uri?: string }>();
  let nodeUuid = body.node_uuid;
  if (!nodeUuid && body.uri) {
    const parsed = parseMemoryUri(body.uri);
    const node = await c.var.service.getNode(parsed.domain, parsed.path, true);
    nodeUuid = node.node_uuid ?? undefined;
  }
  if (!nodeUuid) return jsonError("node_uuid or uri is required");
  await c.env.DB.prepare("INSERT OR IGNORE INTO glossary_keywords(keyword,node_uuid,namespace) VALUES(?,?,?)").bind(body.keyword, nodeUuid, c.var.namespace).run();
  return c.json({ success: true });
});

api.delete("/browse/glossary", async (c) => {
  const body = await c.req.json<{ keyword: string; node_uuid: string }>();
  await c.env.DB.prepare("DELETE FROM glossary_keywords WHERE keyword=? AND node_uuid=? AND namespace=?").bind(body.keyword, body.node_uuid, c.var.namespace).run();
  return c.json({ success: true });
});

api.get("/browse/search", async (c) => {
  const results = await c.var.service.search(c.req.query("q") ?? "", c.req.query("domain") || undefined, Number(c.req.query("limit") ?? "20"));
  return c.json({ results });
});

api.get("/settings", async (c) => {
  const domains = await c.var.service.validDomains();
  const locale = await c.env.DB.prepare("SELECT value_json FROM settings WHERE key='locale'").first<{ value_json: string }>();
  return c.json({
    runtime: "cloudflare",
    valid_domains: domains,
    locale: locale ? JSON.parse(locale.value_json) : null,
    readonly: false,
    host: "workers.dev",
    web_port: 443,
    database_url: "D1 binding: DB",
    cors_origins: [],
    api_token: null,
    locked_fields: ["host", "web_port", "database_url", "cors_origins", "api_token"],
    message: "Cloudflare runtime stores API_TOKEN as a Worker secret; the Dashboard only keeps your token in local browser storage.",
  });
});

api.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if ("valid_domains" in body) {
    await c.env.DB.prepare(
      `INSERT INTO settings(key,value_json) VALUES('valid_domains',?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`,
    ).bind(JSON.stringify(body.valid_domains)).run();
  }
  if ("locale" in body) {
    await c.env.DB.prepare(
      `INSERT INTO settings(key,value_json) VALUES('locale',?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`,
    ).bind(JSON.stringify(body.locale)).run();
  }
  return c.json({ success: true, locked_fields: ["host", "web_port", "database_url", "cors_origins", "api_token"] });
});

api.get("/settings/boot-uris", async (c) => c.json({ uris: await c.var.service.bootUris() }));
api.put("/settings/boot-uris", async (c) => {
  const body = await c.req.json<{ uris: string[] }>();
  await c.var.service.setBootUris(body.uris);
  return c.json({ success: true, uris: body.uris });
});
api.patch("/settings/boot-uris", async (c) => {
  const body = await c.req.json<{ uri: string; enabled: boolean }>();
  const uris = new Set(await c.var.service.bootUris());
  if (body.enabled) uris.add(body.uri);
  else uris.delete(body.uri);
  const next = [...uris];
  await c.var.service.setBootUris(next);
  return c.json({ success: true, uris: next });
});
api.get("/settings/boot-uris/all", async (c) => {
  const row = await c.env.DB.prepare("SELECT boot_uris FROM presets WHERE is_active=1 LIMIT 1").first<{ boot_uris: string }>();
  return c.json({ boot_uris: row ? JSON.parse(row.boot_uris) : {} });
});
api.put("/settings/boot-uris/ns/:namespace", async (c) => {
  const body = await c.req.json<{ uris: string[] }>();
  const ns = decodeURIComponent(c.req.param("namespace"));
  await c.var.service.setBootUris(body.uris, ns === "_" ? "" : ns);
  return c.json({ success: true, uris: body.uris });
});
api.delete("/settings/boot-uris/ns/:namespace", async (c) => {
  const ns = decodeURIComponent(c.req.param("namespace"));
  await c.var.service.setBootUris([], ns === "_" ? "" : ns);
  return c.json({ success: true });
});

api.get("/settings/database/status", (c) => c.json({ ok: true, runtime: "cloudflare", database_url: "D1 binding: DB", locked: true }));
api.post("/settings/database/test", (c) => c.json({ ok: true, runtime: "cloudflare", locked: true }));
api.post("/settings/database/create", () => jsonError("Database creation is managed with `wrangler d1 create` in Cloudflare runtime.", 409));
api.post("/settings/database/open-folder", () => jsonError("Cloudflare D1 has no local database folder in production.", 409));

api.get("/presets", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id,name,boot_uris,path_masks,is_active,created_at,updated_at FROM presets ORDER BY is_active DESC,name").all();
  return c.json({ presets: rows.results ?? [] });
});
api.post("/presets", async (c) => {
  const body = await c.req.json<{ name: string; boot_uris?: Record<string, string[]>; path_masks?: unknown }>();
  const result = await c.env.DB.prepare("INSERT INTO presets(name,boot_uris,path_masks,is_active) VALUES(?,?,?,0)")
    .bind(body.name, JSON.stringify(body.boot_uris ?? {}), JSON.stringify(body.path_masks ?? null)).run();
  return c.json({ id: result.meta.last_row_id, success: true }, 201);
});
api.get("/presets/:id", async (c) => c.json(await c.env.DB.prepare("SELECT * FROM presets WHERE id=?").bind(c.req.param("id")).first()));
api.put("/presets/:id", async (c) => {
  const body = await c.req.json<{ name?: string; boot_uris?: Record<string, string[]>; path_masks?: unknown }>();
  await c.env.DB.prepare("UPDATE presets SET name=coalesce(?,name),boot_uris=coalesce(?,boot_uris),path_masks=coalesce(?,path_masks),updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(body.name ?? null, body.boot_uris ? JSON.stringify(body.boot_uris) : null, body.path_masks ? JSON.stringify(body.path_masks) : null, c.req.param("id")).run();
  return c.json({ success: true });
});
api.delete("/presets/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM presets WHERE id=? AND is_active=0").bind(c.req.param("id")).run();
  return c.json({ success: true });
});
api.post("/presets/:id/activate", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE presets SET is_active=0"),
    c.env.DB.prepare("UPDATE presets SET is_active=1 WHERE id=?").bind(c.req.param("id")),
  ]);
  return c.json({ success: true });
});
api.post("/presets/:id/duplicate", async (c) => {
  const body = await c.req.json<{ new_name?: string }>();
  const row = await c.env.DB.prepare("SELECT name,boot_uris,path_masks FROM presets WHERE id=?").bind(c.req.param("id")).first<{ name: string; boot_uris: string; path_masks: string | null }>();
  if (!row) return jsonError("Preset not found", 404);
  await c.env.DB.prepare("INSERT INTO presets(name,boot_uris,path_masks,is_active) VALUES(?,?,?,0)").bind(body.new_name ?? `${row.name} Copy`, row.boot_uris, row.path_masks).run();
  return c.json({ success: true });
});

api.get("/review/groups", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT node_uuid,count(*) AS changes,max(updated_at) AS updated_at
     FROM changeset_rows GROUP BY node_uuid ORDER BY updated_at DESC`,
  ).all();
  return c.json(rows.results ?? []);
});
api.get("/review/groups/:nodeUuid/diff", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM changeset_rows WHERE node_uuid=? ORDER BY updated_at").bind(c.req.param("nodeUuid")).all();
  return c.json({ node_uuid: c.req.param("nodeUuid"), rows: rows.results ?? [] });
});
api.post("/review/groups/:nodeUuid/rollback", async (c) => {
  await c.env.DB.prepare("DELETE FROM changeset_rows WHERE node_uuid=?").bind(c.req.param("nodeUuid")).run();
  return c.json({ success: true, message: "Cloudflare preview rollback clears pending audit rows; destructive data rollback should use D1 Time Travel or an R2 backup." });
});
api.delete("/review/groups/:nodeUuid", async (c) => {
  await c.env.DB.prepare("DELETE FROM changeset_rows WHERE node_uuid=?").bind(c.req.param("nodeUuid")).run();
  return c.json({ success: true });
});
api.delete("/review", async (c) => {
  await c.env.DB.prepare("DELETE FROM changeset_rows").run();
  return c.json({ success: true });
});
api.get("/review/deprecated", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM memories WHERE deprecated=1 ORDER BY created_at DESC LIMIT 200").all();
  return c.json({ memories: rows.results ?? [] });
});
api.delete("/review/memories/:memoryId", async (c) => {
  await c.env.DB.prepare("DELETE FROM memories WHERE id=? AND deprecated=1").bind(c.req.param("memoryId")).run();
  return c.json({ success: true });
});
api.post("/review/diff", async (c) => {
  const body = await c.req.json<{ before: string; after: string }>();
  return c.json({ before: body.before, after: body.after, changed: body.before !== body.after });
});

api.get("/maintenance/orphans", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.* FROM memories m LEFT JOIN paths p ON p.node_uuid=m.node_uuid
     WHERE p.node_uuid IS NULL ORDER BY m.created_at DESC LIMIT 200`,
  ).all();
  return c.json({ memories: rows.results ?? [] });
});
api.get("/maintenance/orphans/:memoryId", async (c) => c.json(await c.env.DB.prepare("SELECT * FROM memories WHERE id=?").bind(c.req.param("memoryId")).first()));
api.delete("/maintenance/orphans/:memoryId", async (c) => {
  await c.env.DB.prepare("DELETE FROM memories WHERE id=?").bind(c.req.param("memoryId")).run();
  return c.json({ success: true });
});
api.post("/maintenance/orphans/:memoryId/restore", async (c) => {
  const body = await c.req.json<{ uri: string; priority?: number; disclosure?: string }>();
  const memory = await c.env.DB.prepare("SELECT node_uuid,content FROM memories WHERE id=?").bind(c.req.param("memoryId")).first<{ node_uuid: string; content: string }>();
  if (!memory) return jsonError("Memory not found", 404);
  const parsed = parseMemoryUri(body.uri);
  const parent = normalizePath(parsed.path.split("/").slice(0, -1).join("/"));
  const parentNode = parent ? (await c.var.service.getNode(parsed.domain, parent, true)).node_uuid : null;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO edges(parent_uuid,child_uuid,name,priority,disclosure) VALUES(?,?,?,?,?)").bind(parentNode, memory.node_uuid, parsed.path.split("/").at(-1) ?? "restored", body.priority ?? 0, body.disclosure ?? ""),
    c.env.DB.prepare(`INSERT INTO paths(namespace,domain,path,edge_id,node_uuid) VALUES(?,?,?,(SELECT id FROM edges WHERE child_uuid=? ORDER BY id DESC LIMIT 1),?)`)
      .bind(c.var.namespace, parsed.domain, parsed.path, memory.node_uuid, memory.node_uuid),
  ]);
  return c.json({ success: true, uri: body.uri });
});
api.get("/maintenance/access-logs/stats", async (c) => {
  const rows = await c.env.DB.prepare("SELECT date(accessed_at) AS day,count(*) AS count FROM memory_access_logs WHERE namespace=? GROUP BY day ORDER BY day DESC LIMIT 30")
    .bind(c.var.namespace).all();
  return c.json({ stats: rows.results ?? [] });
});
api.delete("/maintenance/access-logs", async (c) => {
  const body = await c.req.json<{ keep_days?: number }>().catch(() => ({ keep_days: 30 }));
  await c.env.DB.prepare("DELETE FROM memory_access_logs WHERE namespace=? AND accessed_at < datetime('now', ?)").bind(c.var.namespace, `-${body.keep_days ?? 30} days`).run();
  return c.json({ success: true });
});

api.post("/attachments", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  const nodeUuid = String(form.get("node_uuid") ?? "");
  if (!(file instanceof File)) return jsonError("file is required");
  if (!nodeUuid) return jsonError("node_uuid is required");
  if (file.size > 10 * 1024 * 1024) return jsonError("File exceeds 10 MB limit", 413);
  const id = crypto.randomUUID();
  const objectKey = `attachments/${c.var.namespace}/${nodeUuid}/${id}`;
  const uploaded = await c.env.ATTACHMENTS.put(objectKey, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { filename: file.name, node_uuid: nodeUuid, namespace: c.var.namespace },
  });
  await c.env.DB.prepare(
    "INSERT INTO attachments(id,object_key,namespace,node_uuid,filename,content_type,size_bytes,etag) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(id, objectKey, c.var.namespace, nodeUuid, file.name, file.type || "application/octet-stream", file.size, uploaded.etag).run();
  return c.json({ id, filename: file.name, size_bytes: file.size }, 201);
});
api.get("/attachments/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM attachments WHERE id=? AND namespace=?").bind(c.req.param("id"), c.var.namespace).first<{
    object_key: string;
    filename: string;
    content_type: string;
    size_bytes: number;
  }>();
  if (!row) return jsonError("Attachment not found", 404);
  const object = await c.env.ATTACHMENTS.get(row.object_key);
  if (!object) return jsonError("R2 object not found", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Length": String(row.size_bytes),
      "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
    },
  });
});
api.delete("/attachments/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT object_key FROM attachments WHERE id=? AND namespace=?").bind(c.req.param("id"), c.var.namespace).first<{ object_key: string }>();
  if (!row) return jsonError("Attachment not found", 404);
  await c.env.ATTACHMENTS.delete(row.object_key);
  await c.env.DB.prepare("DELETE FROM attachments WHERE id=? AND namespace=?").bind(c.req.param("id"), c.var.namespace).run();
  return c.json({ success: true });
});

export function apiError(error: unknown): Response {
  return jsonError("Internal error", 500, asErrorMessage(error));
}
