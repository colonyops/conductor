import type { Session } from "../types.js";

export interface NewSessionArgs {
  name: string;
  remote: string;
  background?: boolean;
  cloneStrategy?: "full" | "worktree";
  agent?: string;
}

export interface HiveClient {
  newSession(args: NewSessionArgs): Promise<Session>;
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<Session | undefined>;
}
