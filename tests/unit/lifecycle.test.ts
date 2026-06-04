import { describe, expect, it } from "vitest";
import { transition } from "../../src/core/lifecycle.js";
import type { Session } from "../../src/types.js";

function makeSession(state: Session["state"]): Session {
  return {
    id: "test-123",
    name: "test",
    state,
    pluginId: "plugin-a",
    createdAt: new Date(),
    eventsDir: "/tmp/events",
    workDir: "/tmp/work",
    isEphemeral: false,
  };
}

const OPTS = { idleTimeoutMs: 60_000 };

describe("transition", () => {
  describe("CREATED", () => {
    it("PostToolUse → ACTIVE with startIdleTimer + emitSessionActive", () => {
      const result = transition(makeSession("CREATED"), "PostToolUse", OPTS);
      expect(result.nextState).toBe("ACTIVE");
      expect(result.actions.some((a) => a.type === "startIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionActive")).toBe(
        true,
      );
    });

    it("Stop → throws", () => {
      expect(() => transition(makeSession("CREATED"), "Stop", OPTS)).toThrow();
    });

    it("IdleTimeout → throws", () => {
      expect(() =>
        transition(makeSession("CREATED"), "IdleTimeout", OPTS),
      ).toThrow();
    });
  });

  describe("ACTIVE", () => {
    it("Stop (no approval) → IDLE with startIdleTimer + emitSessionIdle", () => {
      const result = transition(makeSession("ACTIVE"), "Stop", OPTS);
      expect(result.nextState).toBe("IDLE");
      expect(result.actions.some((a) => a.type === "cancelIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "startIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionIdle")).toBe(
        true,
      );
    });

    it("Stop (approval) → APPROVAL with emitSessionApproval", () => {
      const result = transition(makeSession("ACTIVE"), "Stop", {
        ...OPTS,
        isApprovalPending: true,
      });
      expect(result.nextState).toBe("APPROVAL");
      expect(result.actions.some((a) => a.type === "cancelIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionApproval")).toBe(
        true,
      );
    });

    it("PostToolUse → ACTIVE (resets idle timer)", () => {
      const result = transition(makeSession("ACTIVE"), "PostToolUse", OPTS);
      expect(result.nextState).toBe("ACTIVE");
      expect(result.actions.some((a) => a.type === "cancelIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "startIdleTimer")).toBe(
        true,
      );
    });

    it("IdleTimeout → IDLE", () => {
      const result = transition(makeSession("ACTIVE"), "IdleTimeout", OPTS);
      expect(result.nextState).toBe("IDLE");
    });
  });

  describe("IDLE", () => {
    it("PostToolUse → ACTIVE with emitSessionActive", () => {
      const result = transition(makeSession("IDLE"), "PostToolUse", OPTS);
      expect(result.nextState).toBe("ACTIVE");
      expect(result.actions.some((a) => a.type === "cancelIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionActive")).toBe(
        true,
      );
    });

    it("IdleTimeout → COMPLETE with triggerCleanup + emitSessionComplete", () => {
      const result = transition(makeSession("IDLE"), "IdleTimeout", OPTS);
      expect(result.nextState).toBe("COMPLETE");
      expect(result.actions.some((a) => a.type === "triggerCleanup")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionComplete")).toBe(
        true,
      );
    });

    it("Stop (no approval) → COMPLETE", () => {
      const result = transition(makeSession("IDLE"), "Stop", OPTS);
      expect(result.nextState).toBe("COMPLETE");
      expect(result.actions.some((a) => a.type === "emitSessionComplete")).toBe(
        true,
      );
    });

    it("Stop (approval) → APPROVAL", () => {
      const result = transition(makeSession("IDLE"), "Stop", {
        ...OPTS,
        isApprovalPending: true,
      });
      expect(result.nextState).toBe("APPROVAL");
      expect(result.actions.some((a) => a.type === "emitSessionApproval")).toBe(
        true,
      );
    });
  });

  describe("APPROVAL", () => {
    it("PostToolUse → ACTIVE with startIdleTimer", () => {
      const result = transition(makeSession("APPROVAL"), "PostToolUse", OPTS);
      expect(result.nextState).toBe("ACTIVE");
      expect(result.actions.some((a) => a.type === "startIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionActive")).toBe(
        true,
      );
    });

    it("ApprovalResolved → ACTIVE", () => {
      const result = transition(
        makeSession("APPROVAL"),
        "ApprovalResolved",
        OPTS,
      );
      expect(result.nextState).toBe("ACTIVE");
      expect(result.actions.some((a) => a.type === "startIdleTimer")).toBe(
        true,
      );
      expect(result.actions.some((a) => a.type === "emitSessionActive")).toBe(
        true,
      );
    });

    it("Stop → throws", () => {
      expect(() => transition(makeSession("APPROVAL"), "Stop", OPTS)).toThrow();
    });
  });

  describe("COMPLETE", () => {
    it("any event → no-op (stays COMPLETE, no actions)", () => {
      for (const event of [
        "PostToolUse",
        "Stop",
        "IdleTimeout",
        "ApprovalResolved",
      ] as const) {
        const result = transition(makeSession("COMPLETE"), event, OPTS);
        expect(result.nextState).toBe("COMPLETE");
        expect(result.actions).toHaveLength(0);
      }
    });
  });

  describe("invalid transitions", () => {
    it("throws on unknown combination", () => {
      expect(() =>
        transition(makeSession("CREATED"), "IdleTimeout", OPTS),
      ).toThrow(/Invalid state transition/);
    });
  });
});
