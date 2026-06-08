import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KVStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** List all keys, optionally filtered to those starting with prefix. */
  keys(prefix?: string): Promise<string[]>;
  /** Delete all keys in this store's scope. */
  clear(): Promise<void>;
}

type KVRow = { value: string };
type CountRow = { c: number };
type KeyRow = { key: string };
type AllKeyRow = { plugin_id: string; key: string; value: string };

export type KVEntry = { pluginId: string; key: string; value: string };

/** Escape SQLite LIKE wildcards (`\`, `%`, `_`) so a prefix is matched literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class BunSqliteKVStore implements KVStore {
  constructor(
    private readonly pluginId: string,
    private readonly db: Database,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db
      .query<KVRow, [string, string]>("SELECT value FROM kv WHERE plugin_id = ? AND key = ?")
      .get(this.pluginId, key);
    if (!row) return undefined;
    return JSON.parse(row.value) as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.db.run("INSERT OR REPLACE INTO kv (plugin_id, key, value) VALUES (?, ?, ?)", [
      this.pluginId,
      key,
      JSON.stringify(value),
    ]);
  }

  async has(key: string): Promise<boolean> {
    const row = this.db
      .query<CountRow, [string, string]>("SELECT COUNT(*) as c FROM kv WHERE plugin_id = ? AND key = ?")
      .get(this.pluginId, key);
    return (row?.c ?? 0) > 0;
  }

  async delete(key: string): Promise<void> {
    this.db.run("DELETE FROM kv WHERE plugin_id = ? AND key = ?", [this.pluginId, key]);
  }

  async keys(prefix?: string): Promise<string[]> {
    if (prefix !== undefined) {
      const pattern = `${escapeLikePattern(prefix)}%`;
      const rows = this.db
        .query<KeyRow, [string, string]>("SELECT key FROM kv WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\'")
        .all(this.pluginId, pattern);
      return rows.map((r) => r.key);
    }
    const rows = this.db.query<KeyRow, [string]>("SELECT key FROM kv WHERE plugin_id = ?").all(this.pluginId);
    return rows.map((r) => r.key);
  }

  async clear(): Promise<void> {
    this.db.run("DELETE FROM kv WHERE plugin_id = ?", [this.pluginId]);
  }
}

export function openKVDatabase(dataDir: string): {
  forPlugin(pluginId: string): KVStore;
  /** List all entries, optionally scoped to a single plugin. */
  listEntries(pluginId?: string): KVEntry[];
  close(): void;
} {
  const dbPath = join(dataDir, "kv.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      plugin_id TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `);

  return {
    forPlugin(pluginId) {
      return new BunSqliteKVStore(pluginId, db);
    },
    listEntries(pluginId?: string): KVEntry[] {
      if (pluginId !== undefined) {
        const rows = db
          .query<AllKeyRow, [string]>("SELECT plugin_id, key, value FROM kv WHERE plugin_id = ? ORDER BY key")
          .all(pluginId);
        return rows.map((r) => ({
          pluginId: r.plugin_id,
          key: r.key,
          value: r.value,
        }));
      }
      const rows = db.query<AllKeyRow, []>("SELECT plugin_id, key, value FROM kv ORDER BY plugin_id, key").all();
      return rows.map((r) => ({
        pluginId: r.plugin_id,
        key: r.key,
        value: r.value,
      }));
    },
    close() {
      db.close();
    },
  };
}
