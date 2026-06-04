import type { CoreEventName, CoreEventPayload } from "../types.js";

export type EventHandler<E extends CoreEventName> = (
  payload: CoreEventPayload<E>,
) => Promise<void>;

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
    await Promise.all(list.map((h) => h(payload)));
  }
}
