import type { EventBus } from "../session/events.js";
import type { SessionManager } from "../session/manager.js";
import type { CoreEventName, CoreEventPayload, Session } from "../types.js";

export interface NewSessionOptions {
  name: string;
  remote: string;
  context?: string;
  agent?: string;
  idleTimeoutMs?: number;
  prePromptOverride?: string;
  postPromptOverride?: string;
}

type SessionEventHandler<E extends CoreEventName> = (payload: CoreEventPayload<E>) => Promise<void>;

export interface HiveClient {
  newSession(opts: NewSessionOptions): Promise<Session>;
  /** Not available in v1 — throws. */
  ephemeralSession(opts: Omit<NewSessionOptions, "remote">): Promise<Session>;
  listSessions(): Session[];
  onSessionCreated(handler: SessionEventHandler<"sessionCreated">): () => void;
  onSessionActive(handler: SessionEventHandler<"sessionActive">): () => void;
  onSessionIdle(handler: SessionEventHandler<"sessionIdle">): () => void;
  onSessionComplete(handler: SessionEventHandler<"sessionComplete">): () => void;
  onSessionRecycled(handler: SessionEventHandler<"sessionRecycled">): () => void;
  onSessionApproval(handler: SessionEventHandler<"sessionApproval">): () => void;
  onSessionError(handler: SessionEventHandler<"sessionError">): () => void;
}

export function createHiveClient(opts: {
  pluginId: string;
  sessionManager: SessionManager;
  eventBus: EventBus;
}): HiveClient {
  const { pluginId, sessionManager, eventBus } = opts;

  function sub<E extends CoreEventName>(name: E, handler: SessionEventHandler<E>): () => void {
    return eventBus.on(name, handler);
  }

  return {
    async newSession(sessionOpts) {
      return sessionManager.createSession({ ...sessionOpts, pluginId });
    },

    async ephemeralSession(_sessionOpts) {
      throw new Error("ephemeralSession is not available in v1");
    },

    listSessions() {
      return sessionManager.listSessions();
    },

    onSessionCreated: (h) => sub("sessionCreated", h),
    onSessionActive: (h) => sub("sessionActive", h),
    onSessionIdle: (h) => sub("sessionIdle", h),
    onSessionComplete: (h) => sub("sessionComplete", h),
    onSessionRecycled: (h) => sub("sessionRecycled", h),
    onSessionApproval: (h) => sub("sessionApproval", h),
    onSessionError: (h) => sub("sessionError", h),
  };
}
