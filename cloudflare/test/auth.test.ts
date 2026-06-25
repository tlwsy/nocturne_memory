import { describe, expect, it } from "vitest";
import { bearerToken, isAuthorized } from "../src/auth";
import type { AppEnv } from "../src/env";

describe("Bearer authentication", () => {
  it("extracts bearer tokens", () => {
    const req = new Request("https://example.test/api", { headers: { Authorization: "Bearer secret" } });
    expect(bearerToken(req)).toBe("secret");
  });

  it("compares token digests without direct string equality", async () => {
    const env = { API_TOKEN: "01234567890123456789012345678901" } as AppEnv;
    await expect(isAuthorized(new Request("https://example.test/api", { headers: { Authorization: `Bearer ${env.API_TOKEN}` } }), env)).resolves.toBe(true);
    await expect(isAuthorized(new Request("https://example.test/api", { headers: { Authorization: "Bearer wrong" } }), env)).resolves.toBe(false);
  });
});
