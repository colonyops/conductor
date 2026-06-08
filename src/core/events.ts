import type { Logger } from "../sdk/logger.js";
import type { CoreEventName, CoreEventPayload } from "../types.js";

export type EventHandler<E extends CoreEventName> = (payload: CoreEventPayload<E>) => Promise<void>;

const HANDLER_TIMEOUT_MS = 30_000;

export class EventBus {
  private handlers = new Map<string, EventHandler<CoreEventName>[]>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  on<E extends CoreEventName>(event: E, handler: EventHandler<E>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as EventHandler<CoreEventName>);
    this.handlers.set(event, list);
    return () => {
      const updated = (this.handlers.get(event) ?? []).filter((h) => h !== handler);
      this.handlers.set(event, updated);
    };
  }

  async emit<E extends CoreEventName>(event: E, payload: CoreEventPayload<E>): Promise<void> {
    const list = this.handlers.get(event) ?? [];
    // Run handlers concurrently so a slow handler does not block the others.
    // Each handler is independently timed out and its failures are isolated.
    await Promise.all(list.map((h) => this.runHandler(event, h as EventHandler<E>, payload)));
  }

  private async runHandler<E extends CoreEventName>(
    event: E,
    handler: EventHandler<E>,
    payload: CoreEventPayload<E>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        handler(payload),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`handler timeout after ${HANDLER_TIMEOUT_MS}ms`)),
            HANDLER_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      this.logger.error("event handler error", {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
