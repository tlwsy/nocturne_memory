import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const TABLES = [
  "nodes",
  "memories",
  "edges",
  "paths",
  "glossary_keywords",
  "search_documents",
  "memory_access_logs",
  "presets",
] as const;

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(table);
  return Boolean(row);
}

function exportTable(db: Database.Database, table: string): { count: number; sql: string[] } {
  if (!tableExists(db, table)) return { count: 0, sql: [] };
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const names = columns.map((column) => column.name);
  const rows = db.prepare(`SELECT ${names.map((name) => `"${name}"`).join(",")} FROM ${table}`).all() as Record<string, unknown>[];
  const sql = rows.map((row) => `INSERT OR REPLACE INTO ${table}(${names.join(",")}) VALUES(${names.map((name) => quote(row[name])).join(",")});`);
  return { count: rows.length, sql };
}

function main(): void {
  const input = arg("input") ?? process.argv[2];
  if (!input) {
    console.error("Usage: npm run import:sqlite -- --input=../demo.db [--namespace=default] [--dry-run] [--out=import-output/import.sql]");
    process.exit(2);
  }
  const dbPath = resolve(input);
  const namespace = arg("namespace");
  const dryRun = hasFlag("dry-run");
  const out = resolve(arg("out") ?? `import-output/${basename(dbPath).replace(/\W+/g, "_")}.d1.sql`);
  const db = new Database(dbPath, { readonly: true });
  db.pragma("foreign_keys=ON");
  const fk = db.pragma("foreign_key_check") as unknown[];
  if (fk.length) throw new Error(`Source DB foreign_key_check failed: ${JSON.stringify(fk.slice(0, 10))}`);

  const statements: string[] = ["PRAGMA foreign_keys=ON;", "BEGIN TRANSACTION;"];
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const exported = exportTable(db, table);
    counts[table] = exported.count;
    statements.push(...exported.sql);
  }
  statements.push("DELETE FROM search_documents_fts;");
  statements.push(
    `INSERT INTO search_documents_fts(namespace,domain,path,node_uuid,uri,content,disclosure,search_terms)
     SELECT namespace,domain,path,node_uuid,uri,content,disclosure,search_terms FROM search_documents;`,
  );
  if (namespace !== undefined) {
    statements.push(`UPDATE paths SET namespace=${quote(namespace)} WHERE namespace IS NULL OR namespace='';`);
    statements.push(`UPDATE search_documents SET namespace=${quote(namespace)} WHERE namespace IS NULL OR namespace='';`);
    statements.push(`UPDATE glossary_keywords SET namespace=${quote(namespace)} WHERE namespace IS NULL OR namespace='';`);
    statements.push(`UPDATE memory_access_logs SET namespace=${quote(namespace)} WHERE namespace IS NULL OR namespace='';`);
  }
  statements.push("COMMIT;");

  console.log(JSON.stringify({ input: dbPath, dryRun, counts, foreign_key_check: "ok" }, null, 2));
  if (!dryRun) {
    mkdirSync(resolve(out, ".."), { recursive: true });
    writeFileSync(out, `${statements.join("\n")}\n`, "utf8");
    console.log(`Wrote D1 import SQL: ${out}`);
    console.log(`Apply locally with: npx wrangler d1 execute nocturne-memory --local --file ${out}`);
  }
}

main();
