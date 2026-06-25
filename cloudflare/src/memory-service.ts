import type { JsonValue } from "./env";
import { joinPath, leafName, makeUri, normalizePath, parentPath, parseMemoryUri } from "./uri";

type Bind = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

type PathRow = {
  namespace: string;
  domain: string;
  path: string;
  edge_id: number | null;
  node_uuid: string;
};

type MemoryRow = {
  id: number;
  node_uuid: string;
  content: string;
  deprecated: number;
  migrated_to: number | null;
  created_at: string;
};

type EdgeRow = {
  id: number;
  parent_uuid: string | null;
  child_uuid: string;
  name: string;
  priority: number;
  disclosure: string | null;
};

export type NodeView = {
  uri: string;
  domain: string;
  path: string;
  node_uuid: string | null;
  content: string;
  priority: number;
  disclosure: string;
  children: Array<{ name: string; path: string; uri: string; priority: number; disclosure: string | null; node_uuid: string; content_snippet?: string; approx_children_count?: number }>;
  aliases: Array<{ domain: string; path: string; uri: string }>;
  glossary_keywords: string[];
  attachments: Array<{ id: string; filename: string; content_type: string; size_bytes: number; created_at: string }>;
};

export class MemoryService {
  constructor(
    private readonly db: D1Database,
    private readonly namespace: string,
  ) {}

  private stmt(sql: string, ...params: Bind[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...params);
  }

  private async first<T>(sql: string, ...params: Bind[]): Promise<T | null> {
    const row = await this.stmt(sql, ...params).first<T>();
    return row ?? null;
  }

  private async all<T>(sql: string, ...params: Bind[]): Promise<T[]> {
    const result = await this.stmt(sql, ...params).all<T>();
    return result.results ?? [];
  }

  async validDomains(): Promise<string[]> {
    const row = await this.first<{ value_json: string }>("SELECT value_json FROM settings WHERE key='valid_domains'");
    const parsed = row ? (JSON.parse(row.value_json) as unknown) : null;
    return Array.isArray(parsed) ? parsed.map(String) : ["core", "writer", "game", "notes", "narrative"];
  }

  async ensureDomain(domain: string): Promise<void> {
    const domains = await this.validDomains();
    if (!domains.includes(domain)) throw new Error(`Unknown domain '${domain}'. Add it in Settings first.`);
  }

  private async pathRow(domain: string, path: string): Promise<PathRow | null> {
    return this.first<PathRow>(
      "SELECT namespace,domain,path,edge_id,node_uuid FROM paths WHERE namespace=? AND domain=? AND path=?",
      this.namespace,
      domain,
      normalizePath(path),
    );
  }

  private async memoryForNode(nodeUuid: string): Promise<MemoryRow | null> {
    return this.first<MemoryRow>(
      "SELECT id,node_uuid,content,deprecated,migrated_to,created_at FROM memories WHERE node_uuid=? AND deprecated=0",
      nodeUuid,
    );
  }

  private async edge(edgeId: number | null): Promise<EdgeRow | null> {
    if (edgeId == null) return null;
    return this.first<EdgeRow>("SELECT id,parent_uuid,child_uuid,name,priority,disclosure FROM edges WHERE id=?", edgeId);
  }

  private changeStmt(tableName: string, rowKey: string, nodeUuid: string | null, before: JsonValue, after: JsonValue): D1PreparedStatement {
    return this.stmt(
      `INSERT INTO changeset_rows(row_key,table_name,node_uuid,before_json,after_json)
       VALUES(?,?,?,?,?)
       ON CONFLICT(row_key) DO UPDATE SET after_json=excluded.after_json, updated_at=CURRENT_TIMESTAMP`,
      rowKey,
      tableName,
      nodeUuid,
      JSON.stringify(before),
      JSON.stringify(after),
    );
  }

  private searchReplaceStmt(namespace: string, domain: string, path: string, nodeUuid: string, memoryId: number, content: string, disclosure: string | null, priority: number): D1PreparedStatement[] {
    const uri = makeUri(domain, path);
    const terms = `${uri}\n${leafName(path)}\n${disclosure ?? ""}\n${content}`;
    return [
      this.stmt("DELETE FROM search_documents WHERE namespace=? AND domain=? AND path=?", namespace, domain, path),
      this.stmt("DELETE FROM search_documents_fts WHERE namespace=? AND domain=? AND path=?", namespace, domain, path),
      this.stmt(
        `INSERT INTO search_documents(namespace,domain,path,node_uuid,memory_id,uri,content,disclosure,search_terms,priority)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        namespace,
        domain,
        path,
        nodeUuid,
        memoryId,
        uri,
        content,
        disclosure,
        terms,
        priority,
      ),
      this.stmt(
        "INSERT INTO search_documents_fts(namespace,domain,path,node_uuid,uri,content,disclosure,search_terms) VALUES(?,?,?,?,?,?,?,?)",
        namespace,
        domain,
        path,
        nodeUuid,
        uri,
        content,
        disclosure,
        terms,
      ),
    ];
  }

  async createMemory(parentUri: string, content: string, priority = 0, disclosure = "", title?: string): Promise<{ success: true; uri: string; node_uuid: string; id: number }> {
    const parent = parseMemoryUri(parentUri);
    await this.ensureDomain(parent.domain);
    const parentClean = normalizePath(parent.path);
    const name = title?.trim() || crypto.randomUUID().slice(0, 8);
    const path = joinPath(parentClean, name);
    if (await this.pathRow(parent.domain, path)) throw new Error(`Memory already exists at ${makeUri(parent.domain, path)}`);

    let parentNode: string | null = null;
    if (parentClean) {
      const parentRow = await this.pathRow(parent.domain, parentClean);
      if (!parentRow) throw new Error(`Parent memory not found: ${makeUri(parent.domain, parentClean)}`);
      parentNode = parentRow.node_uuid;
    }

    const nodeUuid = crypto.randomUUID();
    const edgeId = crypto.randomUUID();
    const tempMemoryKey = crypto.randomUUID();
    const batch = [
      this.stmt("INSERT INTO nodes(uuid) VALUES(?)", nodeUuid),
      this.stmt("INSERT INTO memories(node_uuid,content) VALUES(?,?)", nodeUuid, content),
      this.stmt("INSERT INTO edges(parent_uuid,child_uuid,name,priority,disclosure) VALUES(?,?,?,?,?)", parentNode, nodeUuid, name, priority, disclosure),
      this.stmt(
        `INSERT INTO paths(namespace,domain,path,edge_id,node_uuid)
         VALUES(?,?,?,(SELECT id FROM edges WHERE child_uuid=? AND name=? ORDER BY id DESC LIMIT 1),?)`,
        this.namespace,
        parent.domain,
        path,
        nodeUuid,
        name,
        nodeUuid,
      ),
      this.changeStmt("nodes", `nodes:${nodeUuid}`, nodeUuid, null, { uuid: nodeUuid }),
      this.changeStmt("memories", `memories:${tempMemoryKey}`, nodeUuid, null, { node_uuid: nodeUuid, content }),
      this.changeStmt("edges", `edges:${edgeId}`, nodeUuid, null, { parent_uuid: parentNode, child_uuid: nodeUuid, name, priority, disclosure }),
      this.changeStmt("paths", `paths:${this.namespace}:${parent.domain}:${path}`, nodeUuid, null, { namespace: this.namespace, domain: parent.domain, path, node_uuid: nodeUuid }),
    ];
    await this.db.batch(batch);

    const memory = await this.memoryForNode(nodeUuid);
    if (!memory) throw new Error("Failed to read created memory");
    await this.db.batch(this.searchReplaceStmt(this.namespace, parent.domain, path, nodeUuid, memory.id, content, disclosure, priority));
    return { success: true, uri: makeUri(parent.domain, path), node_uuid: nodeUuid, id: memory.id };
  }

  async getNode(domain: string, path: string, navOnly = false): Promise<NodeView> {
    await this.ensureDomain(domain);
    const clean = normalizePath(path);
    const row = await this.pathRow(domain, clean);
    if (!row) {
      return {
        uri: makeUri(domain, clean),
        domain,
        path: clean,
        node_uuid: null,
        content: "",
        priority: 0,
        disclosure: "",
        children: await this.children(domain, clean),
        aliases: [],
        glossary_keywords: [],
        attachments: [],
      };
    }
    const [memory, edge, children, aliases, glossary, attachments] = await Promise.all([
      navOnly ? Promise.resolve<MemoryRow | null>(null) : this.memoryForNode(row.node_uuid),
      this.edge(row.edge_id),
      this.children(domain, clean),
      this.aliases(row.node_uuid),
      this.glossary(row.node_uuid),
      this.attachments(row.node_uuid),
    ]);
    if (!navOnly) {
      await this.db.batch([
        this.stmt("UPDATE nodes SET last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=?", row.node_uuid),
        this.stmt("INSERT INTO memory_access_logs(node_uuid,namespace,context) VALUES(?,?,?)", row.node_uuid, this.namespace, makeUri(domain, clean)),
      ]);
    }
    return {
      uri: makeUri(domain, clean),
      domain,
      path: clean,
      node_uuid: row.node_uuid,
      content: memory?.content ?? "",
      priority: edge?.priority ?? 0,
      disclosure: edge?.disclosure ?? "",
      children,
      aliases,
      glossary_keywords: glossary,
      attachments,
    };
  }

  async children(domain: string, path: string): Promise<NodeView["children"]> {
    const prefix = normalizePath(path);
    const depthExpr = "length(p.path)-length(replace(p.path,'/',''))";
    const parentDepth = prefix ? prefix.split("/").length - 1 : -1;
    const rows = await this.all<{ path: string; node_uuid: string; priority: number | null; disclosure: string | null; content: string | null; approx_children_count: number }>(
      `SELECT p.path,p.node_uuid,e.priority,e.disclosure,sd.content,
              (SELECT count(*) FROM paths c WHERE c.namespace=p.namespace AND c.domain=p.domain AND c.path LIKE p.path || '/%') AS approx_children_count
       FROM paths p LEFT JOIN edges e ON p.edge_id=e.id
       LEFT JOIN search_documents sd ON sd.namespace=p.namespace AND sd.domain=p.domain AND sd.path=p.path
       WHERE p.namespace=? AND p.domain=? AND p.path<>?
         AND (?='' AND instr(p.path,'/')=0 OR ?<>'' AND p.path LIKE ? AND ${depthExpr}=?)
       ORDER BY coalesce(e.priority,999),p.path`,
      this.namespace,
      domain,
      prefix,
      prefix,
      prefix,
      `${prefix}/%`,
      parentDepth + 1,
    );
    return rows.map((r) => ({
      name: leafName(r.path),
      path: r.path,
      uri: makeUri(domain, r.path),
      priority: r.priority ?? 0,
      disclosure: r.disclosure,
      node_uuid: r.node_uuid,
      content_snippet: r.content ? (r.content.length > 160 ? `${r.content.slice(0, 160)}…` : r.content) : "",
      approx_children_count: r.approx_children_count ?? 0,
    }));
  }

  async aliases(nodeUuid: string): Promise<NodeView["aliases"]> {
    const rows = await this.all<{ domain: string; path: string }>(
      "SELECT domain,path FROM paths WHERE namespace=? AND node_uuid=? ORDER BY domain,path",
      this.namespace,
      nodeUuid,
    );
    return rows.map((r) => ({ ...r, uri: makeUri(r.domain, r.path) }));
  }

  async glossary(nodeUuid: string): Promise<string[]> {
    const rows = await this.all<{ keyword: string }>(
      "SELECT keyword FROM glossary_keywords WHERE namespace=? AND node_uuid=? ORDER BY keyword",
      this.namespace,
      nodeUuid,
    );
    return rows.map((r) => r.keyword);
  }

  async attachments(nodeUuid: string): Promise<NodeView["attachments"]> {
    return this.all<NodeView["attachments"][number]>(
      "SELECT id,filename,content_type,size_bytes,created_at FROM attachments WHERE namespace=? AND node_uuid=? ORDER BY created_at DESC",
      this.namespace,
      nodeUuid,
    );
  }

  async updateMemory(uri: string, patch: { content?: string; old_string?: string; new_string?: string; append?: string; priority?: number; disclosure?: string }): Promise<{ success: true; uri: string; node_uuid: string }> {
    const parsed = parseMemoryUri(uri);
    const row = await this.pathRow(parsed.domain, parsed.path);
    if (!row) throw new Error(`Memory not found: ${uri}`);
    const current = await this.memoryForNode(row.node_uuid);
    if (!current) throw new Error(`Active memory not found: ${uri}`);
    const edge = await this.edge(row.edge_id);

    let nextContent = current.content;
    if (patch.content !== undefined) nextContent = patch.content;
    if (patch.old_string !== undefined || patch.new_string !== undefined) {
      if (!patch.old_string || patch.new_string === undefined) throw new Error("old_string and new_string must be provided together");
      if (!nextContent.includes(patch.old_string)) throw new Error("old_string not found in memory content");
      nextContent = nextContent.replace(patch.old_string, patch.new_string);
    }
    if (patch.append !== undefined) nextContent += patch.append;

    const stmts: D1PreparedStatement[] = [];
    if (nextContent !== current.content) {
      stmts.push(
        this.stmt("UPDATE memories SET deprecated=1,migrated_to=(SELECT seq+1 FROM sqlite_sequence WHERE name='memories') WHERE id=?", current.id),
        this.stmt("INSERT INTO memories(node_uuid,content) VALUES(?,?)", row.node_uuid, nextContent),
        this.changeStmt("memories", `memories:${current.id}`, row.node_uuid, { id: current.id, content: current.content }, { content: nextContent }),
      );
    }
    if (patch.priority !== undefined || patch.disclosure !== undefined) {
      stmts.push(
        this.stmt(
          "UPDATE edges SET priority=coalesce(?,priority),disclosure=coalesce(?,disclosure) WHERE id=?",
          patch.priority ?? null,
          patch.disclosure ?? null,
          row.edge_id,
        ),
        this.changeStmt("edges", `edges:${row.edge_id}`, row.node_uuid, edge ? { priority: edge.priority, disclosure: edge.disclosure } : null, {
          priority: patch.priority ?? edge?.priority ?? 0,
          disclosure: patch.disclosure ?? edge?.disclosure ?? "",
        }),
      );
    }
    if (stmts.length) await this.db.batch(stmts);
    const active = await this.memoryForNode(row.node_uuid);
    const freshEdge = await this.edge(row.edge_id);
    if (active) {
      await this.db.batch(
        this.searchReplaceStmt(this.namespace, parsed.domain, parsed.path, row.node_uuid, active.id, active.content, freshEdge?.disclosure ?? null, freshEdge?.priority ?? 0),
      );
    }
    return { success: true, uri: makeUri(parsed.domain, parsed.path), node_uuid: row.node_uuid };
  }

  async deleteMemory(uri: string): Promise<{ success: true; deleted: string[] }> {
    const parsed = parseMemoryUri(uri);
    const row = await this.pathRow(parsed.domain, parsed.path);
    if (!row) throw new Error(`Memory not found: ${uri}`);
    const prefix = parsed.path ? `${parsed.path}/%` : "%";
    const rows = await this.all<PathRow>(
      "SELECT namespace,domain,path,edge_id,node_uuid FROM paths WHERE namespace=? AND domain=? AND (path=? OR path LIKE ?) ORDER BY length(path) DESC",
      this.namespace,
      parsed.domain,
      parsed.path,
      prefix,
    );
    const stmts: D1PreparedStatement[] = [];
    for (const p of rows) {
      stmts.push(
        this.changeStmt("paths", `paths:${this.namespace}:${p.domain}:${p.path}`, p.node_uuid, { namespace: this.namespace, domain: p.domain, path: p.path, node_uuid: p.node_uuid }, null),
        this.stmt("DELETE FROM search_documents WHERE namespace=? AND domain=? AND path=?", this.namespace, p.domain, p.path),
        this.stmt("DELETE FROM search_documents_fts WHERE namespace=? AND domain=? AND path=?", this.namespace, p.domain, p.path),
        this.stmt("DELETE FROM paths WHERE namespace=? AND domain=? AND path=?", this.namespace, p.domain, p.path),
      );
    }
    await this.db.batch(stmts);
    return { success: true, deleted: rows.map((p) => makeUri(p.domain, p.path)) };
  }

  async addAlias(sourceUri: string, aliasUri: string, priority = 0, disclosure = ""): Promise<{ success: true; uri: string; node_uuid: string }> {
    const source = parseMemoryUri(sourceUri);
    const alias = parseMemoryUri(aliasUri);
    await this.ensureDomain(alias.domain);
    const sourceRow = await this.pathRow(source.domain, source.path);
    if (!sourceRow) throw new Error(`Source memory not found: ${sourceUri}`);
    if (await this.pathRow(alias.domain, alias.path)) throw new Error(`Alias already exists: ${aliasUri}`);
    const aliasParent = parentPath(alias.path);
    let parentNode: string | null = null;
    if (aliasParent) {
      const parent = await this.pathRow(alias.domain, aliasParent);
      if (!parent) throw new Error(`Alias parent not found: ${makeUri(alias.domain, aliasParent)}`);
      parentNode = parent.node_uuid;
    }

    const sourceMemory = await this.memoryForNode(sourceRow.node_uuid);
    const stmts = [
      this.stmt("INSERT INTO edges(parent_uuid,child_uuid,name,priority,disclosure) VALUES(?,?,?,?,?)", parentNode, sourceRow.node_uuid, leafName(alias.path), priority, disclosure),
      this.stmt(
        `INSERT INTO paths(namespace,domain,path,edge_id,node_uuid)
         VALUES(?,?,?,(SELECT id FROM edges WHERE child_uuid=? AND name=? ORDER BY id DESC LIMIT 1),?)`,
        this.namespace,
        alias.domain,
        alias.path,
        sourceRow.node_uuid,
        leafName(alias.path),
        sourceRow.node_uuid,
      ),
      this.changeStmt("paths", `paths:${this.namespace}:${alias.domain}:${alias.path}`, sourceRow.node_uuid, null, { namespace: this.namespace, domain: alias.domain, path: alias.path, node_uuid: sourceRow.node_uuid }),
    ];
    await this.db.batch(stmts);
    if (sourceMemory) {
      await this.db.batch(this.searchReplaceStmt(this.namespace, alias.domain, alias.path, sourceRow.node_uuid, sourceMemory.id, sourceMemory.content, disclosure, priority));
    }
    return { success: true, uri: makeUri(alias.domain, alias.path), node_uuid: sourceRow.node_uuid };
  }

  async manageTriggers(uri: string, add: string[] = [], remove: string[] = []): Promise<{ added: string[]; removed: string[]; keywords: string[] }> {
    const parsed = parseMemoryUri(uri);
    const row = await this.pathRow(parsed.domain, parsed.path);
    if (!row) throw new Error(`Memory not found: ${uri}`);
    const stmts: D1PreparedStatement[] = [];
    for (const keyword of add.map((k) => k.trim()).filter(Boolean)) {
      stmts.push(
        this.stmt("INSERT OR IGNORE INTO glossary_keywords(keyword,node_uuid,namespace) VALUES(?,?,?)", keyword, row.node_uuid, this.namespace),
        this.changeStmt("glossary_keywords", `glossary:${this.namespace}:${row.node_uuid}:${keyword}`, row.node_uuid, null, { keyword, node_uuid: row.node_uuid, namespace: this.namespace }),
      );
    }
    for (const keyword of remove.map((k) => k.trim()).filter(Boolean)) {
      stmts.push(
        this.stmt("DELETE FROM glossary_keywords WHERE keyword=? AND node_uuid=? AND namespace=?", keyword, row.node_uuid, this.namespace),
        this.changeStmt("glossary_keywords", `glossary:${this.namespace}:${row.node_uuid}:${keyword}`, row.node_uuid, { keyword, node_uuid: row.node_uuid, namespace: this.namespace }, null),
      );
    }
    if (stmts.length) await this.db.batch(stmts);
    return { added: add, removed: remove, keywords: await this.glossary(row.node_uuid) };
  }

  async search(query: string, domain?: string, limit = 20): Promise<Array<{ uri: string; node_uuid: string; content: string; priority: number; disclosure: string | null }>> {
    const q = query.trim();
    if (!q) return [];
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const match = `"${q.replace(/"/g, '""')}"`;
    try {
      return await this.all(
        `SELECT d.uri,d.node_uuid,d.content,d.priority,d.disclosure
         FROM search_documents d
         JOIN search_documents_fts f ON f.namespace=d.namespace AND f.domain=d.domain AND f.path=d.path
         WHERE d.namespace=? AND (? IS NULL OR d.domain=?) AND search_documents_fts MATCH ?
         ORDER BY d.priority DESC,d.updated_at DESC LIMIT ?`,
        this.namespace,
        domain ?? null,
        domain ?? null,
        match,
        safeLimit,
      );
    } catch {
      return this.all(
        `SELECT uri,node_uuid,content,priority,disclosure FROM search_documents
         WHERE namespace=? AND (? IS NULL OR domain=?) AND (content LIKE ? OR uri LIKE ? OR disclosure LIKE ?)
         ORDER BY priority DESC,updated_at DESC LIMIT ?`,
        this.namespace,
        domain ?? null,
        domain ?? null,
        `%${q}%`,
        `%${q}%`,
        `%${q}%`,
        safeLimit,
      );
    }
  }

  async systemView(uri: string): Promise<string> {
    const parsed = parseMemoryUri(uri);
    const parts = parsed.path.split("/").filter(Boolean);
    const view = parts[0] || "boot";
    if (view === "boot") {
      const uris = await this.bootUris();
      const chunks = await Promise.all(uris.map((u) => this.readMemoryText(u).catch((e: unknown) => `# ${u}\n${e instanceof Error ? e.message : String(e)}`)));
      return chunks.join("\n\n---\n\n") || "No boot memories configured.";
    }
    if (view === "index") {
      const domain = parts[1] || "core";
      const rows = await this.all<{ path: string }>("SELECT path FROM paths WHERE namespace=? AND domain=? ORDER BY path LIMIT 200", this.namespace, domain);
      return [`# Index: ${domain}`, ...rows.map((r) => `- ${makeUri(domain, r.path)}`)].join("\n");
    }
    if (view === "recent") {
      const n = Math.min(Number(parts[1] ?? "10") || 10, 50);
      const rows = await this.all<{ context: string | null; accessed_at: string }>(
        "SELECT context,accessed_at FROM memory_access_logs WHERE namespace=? ORDER BY accessed_at DESC LIMIT ?",
        this.namespace,
        n,
      );
      return ["# Recent memory access", ...rows.map((r) => `- ${r.accessed_at} ${r.context ?? ""}`)].join("\n");
    }
    if (view === "glossary") {
      const rows = await this.all<{ keyword: string; uri: string }>(
        `SELECT g.keyword,sd.uri FROM glossary_keywords g
         LEFT JOIN search_documents sd ON sd.namespace=g.namespace AND sd.node_uuid=g.node_uuid
         WHERE g.namespace=? ORDER BY g.keyword LIMIT 500`,
        this.namespace,
      );
      return ["# Glossary", ...rows.map((r) => `- ${r.keyword} -> ${r.uri ?? "(orphan)"}`)].join("\n");
    }
    return `Unknown system view: ${view}`;
  }

  async readMemoryText(uri: string): Promise<string> {
    const parsed = parseMemoryUri(uri);
    if (parsed.domain === "system") return this.systemView(uri);
    const node = await this.getNode(parsed.domain, parsed.path);
    if (!node.node_uuid) return `Memory not found: ${uri}`;
    const lines = [`# ${node.uri}`, "", node.content];
    if (node.children.length) {
      lines.push("", "CHILD MEMORIES (Use read_memory with URI to access)");
      for (const child of node.children) lines.push(`- ${child.uri} [priority=${child.priority}] ${child.disclosure ?? ""}`);
    }
    if (node.aliases.length > 1) {
      lines.push("", "ALIASES");
      for (const alias of node.aliases) lines.push(`- ${alias.uri}`);
    }
    if (node.glossary_keywords.length) lines.push("", `TRIGGERS: ${node.glossary_keywords.join(", ")}`);
    return lines.join("\n");
  }

  async bootUris(): Promise<string[]> {
    const active = await this.first<{ boot_uris: string }>("SELECT boot_uris FROM presets WHERE is_active=1 LIMIT 1");
    const parsed = active ? (JSON.parse(active.boot_uris) as Record<string, unknown>) : {};
    const value = parsed[this.namespace] ?? parsed[""] ?? ["core://agent", "core://my_user", "core://agent/my_user"];
    return Array.isArray(value) ? value.map(String) : [];
  }

  async setBootUris(uris: string[], namespace = this.namespace): Promise<void> {
    const active = await this.first<{ id: number; boot_uris: string }>("SELECT id,boot_uris FROM presets WHERE is_active=1 LIMIT 1");
    if (!active) throw new Error("No active preset");
    const obj = JSON.parse(active.boot_uris) as Record<string, string[]>;
    obj[namespace] = uris;
    await this.stmt("UPDATE presets SET boot_uris=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(obj), active.id).run();
  }

  async listNamespaces(): Promise<string[]> {
    const rows = await this.all<{ namespace: string }>("SELECT DISTINCT namespace FROM paths ORDER BY namespace");
    return rows.map((r) => r.namespace);
  }

  async addDomain(domain: string): Promise<string[]> {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(domain)) throw new Error("Invalid domain");
    const domains = await this.validDomains();
    if (!domains.includes(domain)) domains.push(domain);
    await this.stmt(
      `INSERT INTO settings(key,value_json) VALUES('valid_domains',?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`,
      JSON.stringify(domains),
    ).run();
    return domains;
  }

  async deleteDomain(domain: string): Promise<string[]> {
    const count = await this.first<{ n: number }>("SELECT count(*) AS n FROM paths WHERE namespace=? AND domain=?", this.namespace, domain);
    if ((count?.n ?? 0) > 0) throw new Error("Cannot delete a non-empty domain");
    const domains = (await this.validDomains()).filter((d) => d !== domain);
    await this.stmt("UPDATE settings SET value_json=?,updated_at=CURRENT_TIMESTAMP WHERE key='valid_domains'", JSON.stringify(domains)).run();
    return domains;
  }
}
