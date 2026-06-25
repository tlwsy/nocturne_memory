import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppEnv } from "./env";
import { MemoryService } from "./memory-service";

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function successLine(prefix: string, payload: unknown): string {
  return `${prefix}\n\n${JSON.stringify(payload, null, 2)}`;
}

export function createMemoryMcpServer(env: AppEnv, namespace: string): McpServer {
  const service = new MemoryService(env.DB, namespace);
  const server = new McpServer({ name: "nocturne-memory-cloudflare", version: "2.5.4" });

  server.tool("read_memory", { uri: z.string().describe("Memory URI, e.g. core://agent or system://boot") }, async ({ uri }) => {
    try {
      return text(await service.readMemoryText(uri));
    } catch (error) {
      return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.tool(
    "create_memory",
    {
      parent_uri: z.string(),
      content: z.string(),
      priority: z.number().int().min(0).default(0),
      disclosure: z.string().default(""),
      title: z.string().optional(),
    },
    async ({ parent_uri, content, priority, disclosure, title }) => {
      try {
        const result = await service.createMemory(parent_uri, content, priority, disclosure, title);
        return text(
          `Success: Memory created at '${result.uri}'\n\n` +
            "[SYSTEM REMINDER]: Look around your memory network. If related memories should surface this one, use add_alias or manage_triggers.\n\n" +
            successLine("Created memory:", result),
        );
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    "update_memory",
    {
      uri: z.string(),
      old_string: z.string().optional(),
      new_string: z.string().optional(),
      append: z.string().optional(),
      content: z.string().optional(),
      priority: z.number().int().min(0).optional(),
      disclosure: z.string().optional(),
    },
    async (args) => {
      try {
        const result = await service.updateMemory(args.uri, args);
        return text(successLine(`Success: Memory updated at '${result.uri}'`, result));
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool("delete_memory", { uri: z.string() }, async ({ uri }) => {
    try {
      const result = await service.deleteMemory(uri);
      return text(successLine(`Success: Deleted memory path '${uri}'`, result));
    } catch (error) {
      return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.tool(
    "add_alias",
    {
      new_uri: z.string(),
      target_uri: z.string(),
      priority: z.number().int().min(0).default(0),
      disclosure: z.string().default(""),
    },
    async ({ new_uri, target_uri, priority, disclosure }) => {
      try {
        const result = await service.addAlias(target_uri, new_uri, priority, disclosure);
        return text(`Success: Alias '${result.uri}' now points to same memory as '${target_uri}'`);
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    "manage_triggers",
    {
      uri: z.string(),
      add: z.array(z.string()).default([]),
      remove: z.array(z.string()).default([]),
    },
    async ({ uri, add, remove }) => {
      try {
        const result = await service.manageTriggers(uri, add, remove);
        return text(`Added: ${result.added.join(", ") || "(none)"}\nRemoved: ${result.removed.join(", ") || "(none)"}\nCurrent: ${result.keywords.join(", ") || "(none)"}`);
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    "search_memory",
    {
      query: z.string(),
      domain: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ query, domain, limit }) => {
      try {
        const results = await service.search(query, domain, limit);
        if (!results.length) return text("No matching memories found.");
        return text(
          results
            .map((r) => {
              const excerpt = r.content.length > 260 ? `${r.content.slice(0, 260)}…` : r.content;
              return `- ${r.uri} [priority=${r.priority}]${r.disclosure ? ` ${r.disclosure}` : ""}\n${excerpt}`;
            })
            .join("\n\n"),
        );
      } catch (error) {
        return text(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  return server;
}

export function handleMcp(request: Request, env: AppEnv, ctx: ExecutionContext, namespace: string): Promise<Response> {
  const server = createMemoryMcpServer(env, namespace);
  return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
}
