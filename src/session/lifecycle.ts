import type { Session, SessionEvent, SessionState } from "../types.js";

export type TransitionAction =
  | { type: "startIdleTimer"; sessionId: string; timeoutMs: number }
  | { type: "cancelIdleTimer"; sessionId: string }
  | { type: "emitSessionActive"; session: Session }
  | { type: "emitSessionIdle"; session: Session }
  | { type: "emitSessionComplete"; session: Session }
  | { type: "emitSessionApproval"; session: Session }
  | { type: "triggerCleanup"; sessionId: string };

export interface TransitionResult {
  nextState: SessionState;
  actions: TransitionAction[];
}

export interface TransitionOpts {
  idleTimeoutMs: number;
  isApprovalPending?: boolean;
}

/**
 * Pure state machine transition. Returns the next state and side effects.
 * Throws on invalid transitions. COMPLETE + any event is a silent no-op.
 *
 * Transition table:
 *   CREATED  + PostToolUse               → ACTIVE   [startIdleTimer, emitSessionActive]
 *   ACTIVE   + PostToolUse               → ACTIVE   [cancelIdleTimer, startIdleTimer]
 *   ACTIVE   + Stop (no approval)        → IDLE     [cancelIdleTimer, startIdleTimer, emitSessionIdle]
 *   ACTIVE   + Stop (approval)           → APPROVAL [cancelIdleTimer, emitSessionApproval]
 *   ACTIVE   + IdleTimeout               → IDLE     [startIdleTimer, emitSessionIdle]
 *   IDLE     + PostToolUse               → ACTIVE   [cancelIdleTimer, startIdleTimer, emitSessionActive]
 *   IDLE     + IdleTimeout               → COMPLETE [triggerCleanup, emitSessionComplete]
 *   IDLE     + Stop (no approval)        → COMPLETE [cancelIdleTimer, emitSessionComplete]
 *   IDLE     + Stop (approval)           → APPROVAL [cancelIdleTimer, emitSessionApproval]
 *   APPROVAL + PostToolUse               → ACTIVE   [startIdleTimer, emitSessionActive]
 *   APPROVAL + ApprovalResolved          → ACTIVE   [startIdleTimer, emitSessionActive]
 *   COMPLETE + *                         → no-op
 */
export function transition(session: Session, event: SessionEvent, opts: TransitionOpts): TransitionResult {
  const { state } = session;
  const { idleTimeoutMs, isApprovalPending = false } = opts;

  if (state === "COMPLETE") {
    return { nextState: "COMPLETE", actions: [] };
  }

  if (state === "CREATED" && event === "PostToolUse") {
    return {
      nextState: "ACTIVE",
      actions: [
        {
          type: "startIdleTimer",
          sessionId: session.id,
          timeoutMs: idleTimeoutMs,
        },
        { type: "emitSessionActive", session },
      ],
    };
  }

  if (state === "ACTIVE" && event === "PostToolUse") {
    return {
      nextState: "ACTIVE",
      actions: [
        { type: "cancelIdleTimer", sessionId: session.id },
        {
          type: "startIdleTimer",
          sessionId: session.id,
          timeoutMs: idleTimeoutMs,
        },
      ],
    };
  }

  if (state === "ACTIVE" && event === "Stop") {
    if (isApprovalPending) {
      return {
        nextState: "APPROVAL",
        actions: [
          { type: "cancelIdleTimer", sessionId: session.id },
          { type: "emitSessionApproval", session },
        ],
      };
    }
    return {
      nextState: "IDLE",
      actions: [
        { type: "cancelIdleTimer", sessionId: session.id },
        {
          type: "startIdleTimer",
          sessionId: session.id,
          timeoutMs: idleTimeoutMs,
        },
        { type: "emitSessionIdle", session },
      ],
    };
  }

  if (state === "ACTIVE" && event === "IdleTimeout") {
    return {
      nextState: "IDLE",
      actions: [
        {
          type: "startIdleTimer",
          sessionId: session.id,
          timeoutMs: idleTimeoutMs,
        },
        { type: "emitSessionIdle", session },
      ],
    };
  }

  if (state === "IDLE" && event === "PostToolUse") {
    return {
      nextState: "ACTIVE",
      actions: [
        { type: "cancelIdleTimer", sessionId: session.id },
        {
          type: "startIdleTimer",
          sessionId: session.id,
          timeoutMs: idleTimeoutMs,
        },
        { type: "emitSessionActive", session },
      ],
    };
  }

  if (state === "IDLE" && event === "IdleTimeout") {
    return {
      nextState: "COMPLETE",
      actions: [
        { type: "triggerCleanup", sessionId: session.id },
        { type: "emitSessionComplete", session },
      ],
    };
  }

  if (state === "IDLE" && event === "Stop") {
    if (isApprovalPending) {
      return {
        nextState: "APPROVAL",
        actions: [
          { type: "cancelIdleTimer", sessionId: session.id },
          { type: "emitSessionApproval", session },
        ],
      };
    }
    return {
      nextState: "COMPLETE",
      actions: [
        { type: "cancelIdleTimer", sessionId: session.id },
        { type: "emitSessionComplete", session },
      ],
    };
  }

  if (state === "APPROVAL" && (event === "PostToolUse" || event === "ApprovalResolved")) {
    return {
      nextState: "ACTIVE",
      actions: [
        {
          type: "startIdleTimer",
          sessionId: session.id,
          timeoutMs: idleTimeoutMs,
        },
        { type: "emitSessionActive", session },
      ],
    };
  }

  throw new Error(`Invalid state transition: ${state} + ${event}${isApprovalPending ? " (approval pending)" : ""}`);
}
