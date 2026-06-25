# Nocturne Memory on Cloudflare Workers + D1/R2

This directory adds a Cloudflare runtime beside the existing Python/Docker runtime. The Python backend remains the compatibility/reference implementation; this Worker provides:

- React Dashboard static assets from `../frontend/dist`
- Bearer-token protected `/api/*`
- Bearer-token protected stateless Streamable HTTP MCP endpoint at `/mcp`
- D1-backed graph, settings, search, audit rows, presets and access logs
- private R2-backed attachments and backup targets

## Local setup

```bash
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run migrate:local
npm run build:frontend
npm run dev
```

Set a local token in `.dev.vars`:

```text
API_TOKEN=replace-with-at-least-32-random-characters
```

The Dashboard stores the token in browser local storage. The Settings API never returns or mutates `API_TOKEN`.

## Cloudflare resources

```bash
npx wrangler d1 create nocturne-memory
npx wrangler r2 bucket create nocturne-memory-private
npx wrangler secret put API_TOKEN
```

Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the D1 database ID, then:

```bash
npm run migrate:remote
npm run deploy
```

## SQLite import

The importer is intentionally one-way and offline. It preserves IDs, UUIDs, version chains, paths, namespaces, presets and glossary rows; it excludes legacy host/token settings and does not import unconfirmed pending changesets.

```bash
npm run import:sqlite -- --input=../demo.db --dry-run
npm run import:sqlite -- --input=../demo.db --out=import-output/demo.d1.sql
npx wrangler d1 execute nocturne-memory --local --file import-output/demo.d1.sql
```

## Compatibility notes

- `/sse` and `/messages` are not implemented in the Worker runtime. Use the Python runtime for legacy SSE clients.
- Search uses D1 FTS5 `trigram`; Chinese and substring matching are supported, but jieba/pinyin ranking is intentionally not ported.
- Review rollback is intentionally conservative in the Worker preview. Use D1 Time Travel or R2 backups for destructive recovery.
