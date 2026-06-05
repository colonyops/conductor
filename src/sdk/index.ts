import type { Plugin } from "../types.js";

export type { KVStore } from "./kv.js";
export { openKVDatabase } from "./kv.js";
export type { SchedulerHandle, Scheduler } from "./scheduler.js";
export { createScheduler } from "./scheduler.js";
export type { LogLevel, LogEntry, Logger } from "./logger.js";
export { createLogger } from "./logger.js";
export type { GetSecretOptions, SecretsClient } from "./secrets.js";
export { createSecretsClient } from "./secrets.js";
export type { NewSessionOptions, HiveClient } from "./client.js";
export { createHiveClient } from "./client.js";
export type { ConcurrencyLimiter } from "./concurrency.js";
export { createConcurrencyLimiter } from "./concurrency.js";
export type {
  HttpClient,
  HttpRequestArgs,
  HttpResponse,
  RequestInterceptor,
  ResponseInterceptor,
} from "./http.js";
export { createHttpClient } from "./http.js";
export type { Plugin, PluginContext, PluginMeta } from "../types.js";

/**
 * Identity helper — provides TypeScript type checking for plugin modules.
 * Returns the argument unchanged; the only value is the type constraint.
 *
 * Usage: export default definePlugin({ id: "...", name: "...", init: async (ctx) => {} })
 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
