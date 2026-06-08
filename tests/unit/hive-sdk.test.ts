import type { EventBus } from "../../src/core/events.js";
import type { CreateSessionOptions, SessionManager } from "../../src/core/session.js";
import { createHiveClient } from "../../src/sdk/hive.js";
import type { Session } from "../../src/types.js";

// Minimal SessionManager stub that records the options createSession is called
// with, so we can assert how the idle timeout is resolved before storage.
function makeManager(): { manager: SessionManager; calls: CreateSessionOptions[] } {
  const calls: CreateSessionOptions[] = [];
  const manager = {
    async createSession(opts: CreateSessionOptions): Promise<Session> {
      calls.push(opts);
      return {
        id: "sess",
        name: opts.name,
        state: "CREATED",
        pluginId: opts.pluginId,
        createdAt: new Date(0),
        eventsDir: "/tmp/events",
        workDir: "/tmp/work",
        isEphemeral: false,
        ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      };
    },
    listSessions: () => [],
  } as unknown as SessionManager;
  return { manager, calls };
}

const eventBus = { on: () => () => {} } as unknown as EventBus;

const baseOpts = { name: "n", remote: "owner/repo" };

describe("createHiveClient newSession idle timeout resolution", () => {
  it("uses the per-plugin idleTimeoutMs when the session omits its own", async () => {
    const { manager, calls } = makeManager();
    const hive = createHiveClient({ pluginId: "plugin-a", sessionManager: manager, eventBus, idleTimeoutMs: 5_000 });

    await hive.newSession(baseOpts);

    expect(calls[0]?.idleTimeoutMs).toBe(5_000);
  });

  it("prefers the per-session override over the per-plugin default", async () => {
    const { manager, calls } = makeManager();
    const hive = createHiveClient({ pluginId: "plugin-a", sessionManager: manager, eventBus, idleTimeoutMs: 5_000 });

    await hive.newSession({ ...baseOpts, idleTimeoutMs: 1_000 });

    expect(calls[0]?.idleTimeoutMs).toBe(1_000);
  });

  it("leaves idleTimeoutMs unset when neither override is present", async () => {
    const { manager, calls } = makeManager();
    const hive = createHiveClient({ pluginId: "plugin-a", sessionManager: manager, eventBus });

    await hive.newSession(baseOpts);

    expect(calls[0]?.idleTimeoutMs).toBeUndefined();
  });
});
