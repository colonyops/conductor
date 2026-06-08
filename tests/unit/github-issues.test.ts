import githubIssuesPlugin, { issueSlug, parseNextLink } from "../../src/plugins/github-issues.js";
import type { PluginContext, Session } from "../../src/types.js";

describe("issueSlug", () => {
  it("produces gh-{number}-{slug} format", () => {
    expect(issueSlug(15, "docs: user getting-started guide")).toBe("gh-15-docs-user-getting-started-guide");
  });

  it("truncates to 40 chars by default", () => {
    const result = issueSlug(34, "feat: adopt hive v0.53 session lifecycle");
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("gh-34-feat-adopt-hive-v0-53-session-life");
  });

  it("strips trailing hyphen after truncation", () => {
    // Craft a title that would leave a trailing hyphen at the cut point
    const result = issueSlug(1, "a".repeat(40));
    expect(result).not.toMatch(/-$/);
  });

  it("lowercases the title", () => {
    expect(issueSlug(5, "Fix: UPPER CASE TITLE")).toBe("gh-5-fix-upper-case-title");
  });

  it("replaces special characters with hyphens", () => {
    expect(issueSlug(16, "fix: hook signal resolution fails!")).toBe("gh-16-fix-hook-signal-resolution-fails");
  });

  it("collapses multiple special chars into single hyphen", () => {
    expect(issueSlug(7, "feat: foo -- bar")).toBe("gh-7-feat-foo-bar");
  });

  it("respects custom maxLen", () => {
    const result = issueSlug(99, "some very long title that exceeds the limit", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).not.toMatch(/-$/);
  });

  it("produces only lowercase alphanumeric and hyphens", () => {
    const result = issueSlug(42, "feat: [v2] adopt @scope/pkg & update deps!");
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("parseNextLink", () => {
  it("returns undefined for a null header", () => {
    expect(parseNextLink(null)).toBeUndefined();
  });

  it('extracts the rel="next" URL', () => {
    const header =
      '<https://api.github.com/repositories/1/issues?page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/issues?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/repositories/1/issues?page=2");
  });

  it("returns undefined when there is no next page", () => {
    const header =
      '<https://api.github.com/repositories/1/issues?page=1>; rel="prev", ' +
      '<https://api.github.com/repositories/1/issues?page=1>; rel="first"';
    expect(parseNextLink(header)).toBeUndefined();
  });
});

// ── Polling / lifecycle ─────────────────────────────────────────────────────

interface FakeIssue {
  id: number;
  number: number;
  title: string;
}

// makeContext serves one or more pages of issues. Pass a flat array for a
// single page, or an array of arrays to simulate GitHub pagination — each page
// after the first is reached by following the rel="next" Link header.
function makeContext(issuesOrPages: FakeIssue[] | FakeIssue[][], opts: { failNewSession?: boolean } = {}) {
  const pages: FakeIssue[][] =
    issuesOrPages.length > 0 && Array.isArray(issuesOrPages[0])
      ? (issuesOrPages as FakeIssue[][])
      : [issuesOrPages as FakeIssue[]];
  const store = new Map<string, unknown>();
  const kv = {
    async get<T>(key: string): Promise<T | undefined> {
      return store.has(key) ? (store.get(key) as T) : undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async has(key: string): Promise<boolean> {
      return store.has(key);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async keys(prefix?: string): Promise<string[]> {
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };

  const created: Session[] = [];
  let pollFn: (() => Promise<void>) | undefined;
  let completeHandler: ((payload: { session: Session }) => Promise<void>) | undefined;

  const hive = {
    async newSession(sessionOpts: { name: string }): Promise<Session> {
      if (opts.failNewSession) throw new Error("hive unavailable");
      const session = { id: `sess-${created.length + 1}`, name: sessionOpts.name, pluginId: "x" } as unknown as Session;
      created.push(session);
      return session;
    },
    listSessions(): Session[] {
      return [];
    },
    onSessionComplete(handler: (payload: { session: Session }) => Promise<void>): () => void {
      completeHandler = handler;
      return () => {};
    },
  };

  const scheduler = {
    interval(_ms: number, fn: () => Promise<void>) {
      pollFn = fn;
      return { cancel() {} };
    },
  };

  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  const secrets = {
    async get(): Promise<string> {
      return "fake-token";
    },
  };

  const ctx = { kv, hive, scheduler, logger, secrets, http: {} } as unknown as PluginContext;

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls++;
    const url = typeof input === "string" ? input : input.toString();
    const pageMatch = url.match(/[?&]page=(\d+)/);
    const pageNum = pageMatch ? Number(pageMatch[1]) : 1;
    const pageIndex = pageNum - 1;
    const body = pages[pageIndex] ?? [];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (pageIndex + 1 < pages.length) {
      const base = url.replace(/[?&]page=\d+/, "");
      const sep = base.includes("?") ? "&" : "?";
      headers.Link = `<${base}${sep}page=${pageNum + 1}>; rel="next"`;
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as unknown as typeof fetch;

  return {
    ctx,
    store,
    created,
    fetchCalls: () => fetchCalls,
    runPoll: () => pollFn?.() ?? Promise.resolve(),
    complete: (session: Session) => completeHandler?.({ session }) ?? Promise.resolve(),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("github-issues lifecycle", () => {
  const ENV_KEYS = ["CONDUCTOR_GITHUB_REPO", "CONDUCTOR_GITHUB_LABELS", "CONDUCTOR_GITHUB_TOKEN_SOURCE"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.CONDUCTOR_GITHUB_REPO = "acme/widgets";
    process.env.CONDUCTOR_GITHUB_LABELS = "agent";
    process.env.CONDUCTOR_GITHUB_TOKEN_SOURCE = "secret";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  it("spawns one session per new issue", async () => {
    const h = makeContext([{ id: 100, number: 7, title: "fix the thing" }]);
    try {
      await githubIssuesPlugin.init(h.ctx);
      await h.runPoll();
      expect(h.created).toHaveLength(1);
      expect(h.store.has("seen:100")).toBe(true);
    } finally {
      h.restore();
    }
  });

  it("paginates and spawns sessions for issues beyond the first page", async () => {
    const page1: FakeIssue[] = [{ id: 100, number: 7, title: "first page" }];
    const page2: FakeIssue[] = [{ id: 200, number: 8, title: "second page" }];
    const h = makeContext([page1, page2]);
    try {
      await githubIssuesPlugin.init(h.ctx);
      await h.runPoll();
      expect(h.fetchCalls()).toBe(2);
      expect(h.created).toHaveLength(2);
      expect(h.store.has("seen:100")).toBe(true);
      expect(h.store.has("seen:200")).toBe(true);
    } finally {
      h.restore();
    }
  });

  it("records the sessionId on the seen marker after spawning", async () => {
    const h = makeContext([{ id: 100, number: 7, title: "fix the thing" }]);
    try {
      await githubIssuesPlugin.init(h.ctx);
      await h.runPoll();
      const seen = h.store.get("seen:100") as { sessionId?: string };
      expect(seen.sessionId).toBe("sess-1");
    } finally {
      h.restore();
    }
  });

  it("removes the seen marker and retries when newSession fails", async () => {
    const issue = { id: 100, number: 7, title: "fix the thing" };
    const failing = makeContext([issue], { failNewSession: true });
    try {
      await githubIssuesPlugin.init(failing.ctx);
      await failing.runPoll();

      // No session created and the phantom marker is cleaned up so the issue is
      // not permanently orphaned by a transient failure.
      expect(failing.created).toHaveLength(0);
      expect(failing.store.has("seen:100")).toBe(false);
    } finally {
      failing.restore();
    }
  });

  it("does not re-spawn a session for a completed but still-open issue", async () => {
    const issue = { id: 100, number: 7, title: "fix the thing" };
    const h = makeContext([issue]);
    try {
      await githubIssuesPlugin.init(h.ctx);

      // First poll spawns a session.
      await h.runPoll();
      expect(h.created).toHaveLength(1);

      // Session completes; issue remains open (PR review pending).
      const session = h.created[0];
      if (!session) throw new Error("expected a session to have been created");
      await h.complete(session);

      // The seen marker must survive completion and be stamped completed.
      expect(h.store.has("seen:100")).toBe(true);
      const seen = h.store.get("seen:100") as { completedAt?: string };
      expect(seen.completedAt).toBeTruthy();
      // The session-scoped entry is removed.
      expect(h.store.has("session:sess-1")).toBe(false);

      // Subsequent polls must NOT spawn a duplicate session.
      await h.runPoll();
      await h.runPoll();
      expect(h.created).toHaveLength(1);
    } finally {
      h.restore();
    }
  });
});
