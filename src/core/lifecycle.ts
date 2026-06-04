import type { Session, SessionEvent, SessionState } from "../types.js";

export type TransitionAction =
  | { type: "startIdleTimer"; sessionId: string; timeoutMs: number }
  | { type: "cancelIdleTimer"; sessionId: string }
  | { type: "emitSessionActive"; session: Session }
  | { type: "emitSessionIdle"; session: Session }
  | { type: "emitSessionComplete"; session: Session }
  | { type: "emitSessionApproval"; session: Session };

export interface TransitionResult {
  nextState: SessionState;
  actions: TransitionAction[];
}

export function transition(
  session: Session,
  event: SessionEvent,
  idleTimeoutMs: number,
): TransitionResult | null {
  const { state } = session;

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

  if (state === "ACTIVE" && event === "Stop") {
    return {
      nextState: "IDLE",
      actions: [{ type: "emitSessionIdle", session }],
    };
  }

  if (state === "ACTIVE" && event === "IdleTimeout") {
    return {
      nextState: "IDLE",
      actions: [{ type: "emitSessionIdle", session }],
    };
  }

  if (
    (state === "ACTIVE" || state === "IDLE") &&
    event === "ApprovalResolved"
  ) {
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

  if (state === "IDLE" && event === "Stop") {
    return {
      nextState: "COMPLETE",
      actions: [
        { type: "cancelIdleTimer", sessionId: session.id },
        { type: "emitSessionComplete", session },
      ],
    };
  }

  if ((state === "ACTIVE" || state === "IDLE") && event === "Stop") {
    return {
      nextState: "APPROVAL",
      actions: [
        { type: "cancelIdleTimer", sessionId: session.id },
        { type: "emitSessionApproval", session },
      ],
    };
  }

  return null;
}
