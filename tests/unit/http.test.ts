import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHttpClient } from "../../src/sdk/http.js";
import type { Logger } from "../../src/sdk/logger.js";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  with() {
    return noopLogger;
  },
};

describe("createHttpClient withBearer", () => {
  const realFetch = globalThis.fetch;
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    lastInit = undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function authHeader(): string | undefined {
    return (lastInit?.headers as Record<string, string>)?.Authorization;
  }

  it("sets the Authorization header from a synchronous token function", async () => {
    const client = createHttpClient(noopLogger).withBearer(() => "sync-token");
    await client.get({ url: "https://api.example.com/x" });
    expect(authHeader()).toBe("Bearer sync-token");
  });

  it("awaits an async token function instead of stringifying the Promise", async () => {
    const client = createHttpClient(noopLogger).withBearer(async () => "async-token");
    await client.get({ url: "https://api.example.com/x" });
    expect(authHeader()).toBe("Bearer async-token");
  });

  it("omits the Authorization header when the token resolves to null", async () => {
    const client = createHttpClient(noopLogger).withBearer(async () => null);
    await client.get({ url: "https://api.example.com/x" });
    expect(authHeader()).toBeUndefined();
  });

  it("sends no Authorization header when withBearer is not configured", async () => {
    const client = createHttpClient(noopLogger);
    await client.get({ url: "https://api.example.com/x" });
    expect(authHeader()).toBeUndefined();
  });
});
