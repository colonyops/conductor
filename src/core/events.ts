import type { CoreEventName, CoreEventPayload } from "../types.js";

export type EventHandler<E extends CoreEventName> = (
  payload: CoreEventPayload<E>,
) => Promise<void>;

const HANDLER_TIMEOUT_MS = 30_000;

export class EventBus {
  private handlers = new Map<string, EventHandler<CoreEventName>[]>();

  on<E extends CoreEventName>(event: E, handler: EventHandler<E>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as EventHandler<CoreEventName>);
    this.handlers.set(event, list);
    return () => {
      const updated = (this.handlers.get(event) ?? []).filter(
        (h) => h !== handler,
      );
      this.handlers.set(event, updated);
    };
  }

  async emit<E extends CoreEventName>(
    event: E,
    payload: CoreEventPayload<E>,
  ): Promise<void> {
    const list = this.handlers.get(event) ?? [];
    for (const h of list) {
      try {
        await Promise.race([
          (h as EventHandler<E>)(payload),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`handler timeout after ${HANDLER_TIMEOUT_MS}ms`),
                ),
              HANDLER_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        console.error(
          `EventBus: handler error for "${event}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
