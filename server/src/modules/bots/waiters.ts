/**
 * Long polls waiting for a bot's next interaction (GET /v2/bot/interactions?wait=…), in this process. A new interaction
 * wakes its bot's waiters; each then takes what's there from the store, so a second server process would still be
 * correct, only slower (its polls re-check every few seconds).
 */
export class Waiters {
  private readonly waiting = new Map<string, Set<() => void>>();

  /** Resolves when [key] is woken, after [ms], or when [onAbort] fires (the client went away). */
  wait(key: string, ms: number, onAbort?: (wake: () => void) => void): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiting.get(key) ?? new Set<() => void>();
      this.waiting.set(key, set);
      const wake = () => {
        clearTimeout(timer);
        set.delete(wake);
        if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      set.add(wake);
      onAbort?.(wake);
    });
  }

  notify(key: string): void {
    for (const wake of [...(this.waiting.get(key) ?? [])]) wake();
  }

  wakeAll(): void {
    for (const key of [...this.waiting.keys()]) this.notify(key);
  }
}
