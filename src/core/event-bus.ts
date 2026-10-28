// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventHandler = (...args: any[]) => void;

export class EventBus {
  #events = new Map<string, EventHandler[]>();

  on(eventName: string, handler: EventHandler): void {
    if (!this.#events.has(eventName)) {
      this.#events.set(eventName, []);
    }
    this.#events.get(eventName)!.push(handler);
  }

  off(eventName: string, handler: EventHandler): void {
    if (!this.#events.has(eventName)) return;

    const handlers = this.#events.get(eventName)!;
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }

    if (handlers.length === 0) {
      this.#events.delete(eventName);
    }
  }

  once(eventName: string, handler: EventHandler): void {
    const onceHandler = (...args: unknown[]) => {
      handler(...args);
      this.off(eventName, onceHandler);
    };
    this.on(eventName, onceHandler);
  }

  emit(eventName: string, ...args: unknown[]): void {
    if (!this.#events.has(eventName)) return;

    const handlers = this.#events.get(eventName)!;
    handlers.forEach((handler) => handler(...args));
  }

  clear(): void {
    this.#events.clear();
  }
}
