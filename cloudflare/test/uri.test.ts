import { describe, expect, it } from "vitest";
import { joinPath, makeUri, namespaceFromRequest, normalizePath, parseMemoryUri } from "../src/uri";

describe("URI helpers", () => {
  it("parses memory URIs and normalizes slash noise", () => {
    expect(parseMemoryUri("core://agent//user/")).toEqual({ domain: "core", path: "agent/user" });
    expect(makeUri("writer", "draft/")).toBe("writer://draft");
  });

  it("joins parent and title as a single path segment", () => {
    expect(joinPath("agent", "my_user")).toBe("agent/my_user");
    expect(() => joinPath("agent", "bad/title")).toThrow();
  });

  it("prefers X-Namespace over query params", () => {
    const req = new Request("https://example.test/api/browse/node?namespace=query", { headers: { "X-Namespace": "header" } });
    expect(namespaceFromRequest(req)).toBe("header");
  });

  it("normalizes empty root paths", () => {
    expect(normalizePath("/")).toBe("");
  });
});
