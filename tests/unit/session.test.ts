import { applyStateTimestamps, buildSession, resolveSignalInvocation } from "../../src/core/session.js";
import type { Session, SessionState } from "../../src/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-123",
    name: "test",
    state: "CREATED",
    pluginId: "plugin-a",
    createdAt: new Date(0),
    eventsDir: "/tmp/events",
    workDir: "/tmp/work",
    isEphemeral: false,
    ...overrides,
  };
}

describe("applyStateTimestamps", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("moves the session to the next state", () => {
    const result = applyStateTimestamps(makeSession({ state: "CREATED" }), "ACTIVE", now);
    expect(result.state).toBe("ACTIVE");
  });

  it("sets activeSince and clears idleSince when entering ACTIVE", () => {
    const session = makeSession({ state: "CREATED" });
    const result = applyStateTimestamps(session, "ACTIVE", now);
    expect(result.activeSince).toBe(now);
    expect(result.idleSince).toBeUndefined();
  });

  it("clears a prior idleSince when re-entering ACTIVE from IDLE", () => {
    const session = makeSession({ state: "IDLE", idleSince: new Date(1000) });
    const result = applyStateTimestamps(session, "ACTIVE", now);
    expect(result.activeSince).toBe(now);
    expect(result.idleSince).toBeUndefined();
  });

  it("sets idleSince and preserves activeSince when entering IDLE", () => {
    const activeSince = new Date(5000);
    const session = makeSession({ state: "ACTIVE", activeSince });
    const result = applyStateTimestamps(session, "IDLE", now);
    expect(result.idleSince).toBe(now);
    expect(result.activeSince).toBe(activeSince);
  });

  it("preserves timestamps on a self-transition (ACTIVE → ACTIVE)", () => {
    const activeSince = new Date(5000);
    const session = makeSession({ state: "ACTIVE", activeSince });
    const result = applyStateTimestamps(session, "ACTIVE", now);
    expect(result.activeSince).toBe(activeSince);
    expect(result.idleSince).toBeUndefined();
  });

  it("does not mutate the input session", () => {
    const session = makeSession({ state: "ACTIVE", activeSince: new Date(5000) });
    applyStateTimestamps(session, "IDLE", now);
    expect(session.state).toBe("ACTIVE");
    expect(session.idleSince).toBeUndefined();
  });

  it("leaves timestamps untouched for other states", () => {
    const activeSince = new Date(5000);
    const idleSince = new Date(6000);
    for (const next of ["APPROVAL", "COMPLETE"] as SessionState[]) {
      const session = makeSession({ state: "IDLE", activeSince, idleSince });
      const result = applyStateTimestamps(session, next, now);
      expect(result.activeSince).toBe(activeSince);
      expect(result.idleSince).toBe(idleSince);
    }
  });
});

describe("buildSession", () => {
  it("stores the resolved idleTimeoutMs when provided", () => {
    const session = buildSession("id-1", "name", "plugin-a", "/work", false, 12_345);
    expect(session.idleTimeoutMs).toBe(12_345);
  });

  it("omits idleTimeoutMs when not provided so the global default applies", () => {
    const session = buildSession("id-1", "name", "plugin-a", "/work", false);
    expect(session.idleTimeoutMs).toBeUndefined();
    expect("idleTimeoutMs" in session).toBe(false);
  });
});

describe("resolveSignalInvocation", () => {
  const originalArgv1 = process.argv[1] ?? "";
  const originalExecPath = process.execPath;

  afterEach(() => {
    process.argv[1] = originalArgv1;
    // process.execPath is read-only; restore via Object.defineProperty
    Object.defineProperty(process, "execPath", { value: originalExecPath, writable: true });
  });

  it("returns bun + script path in dev mode (argv[1] ends with .ts)", () => {
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/bun", writable: true });
    process.argv[1] = "/home/user/conductor/src/index.ts";

    const result = resolveSignalInvocation();

    expect(result).toBe("/usr/local/bin/bun /home/user/conductor/src/index.ts");
  });

  it("returns execPath alone when running as a compiled binary (argv[1] is not .ts)", () => {
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/conductor", writable: true });
    process.argv[1] = "start";

    const result = resolveSignalInvocation();

    expect(result).toBe("/usr/local/bin/conductor");
  });

  it("returned invocation contains signal subcommand in a full hook command", () => {
    const invocation = resolveSignalInvocation();
    const cmd = `${invocation} signal stop --session abc123`;
    expect(cmd).toContain("signal stop");
    expect(cmd).toContain("--session abc123");
  });
});
