/**
 * Who appears online, from the hub's connection counts, without flapping.
 *
 * A push wake-up opens the app's relay connection for about a second to fetch the queue, then closes it (Android's
 * WakeFetch). Announcing that connection made a person flash online and back offline whenever someone messaged them.
 * Network hand-offs did the same in reverse: a reconnecting phone flashed offline. So a person appears online only once
 * a connection has stayed open for [settleMs], and offline only once they've had none for [graceMs]. Delivery is
 * unaffected: it follows the raw connections (Hub.isDeviceOnline), never this.
 *
 * With both delays 0 (the test default) every change is announced at once, as before.
 */
export interface PresenceTiming {
  settleMs: number;
  graceMs: number;
}

export class PresenceTracker {
  /** People announced online (what everyone sees). */
  private present = new Set<string>();
  /** Connected but not yet announced: the settle timer. */
  private settling = new Map<string, ReturnType<typeof setTimeout>>();
  /** Announced, with no connection left: the grace timer. */
  private leaving = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private timing: PresenceTiming,
    /** True while [userId] has at least one open connection. */
    private connected: (userId: string) => boolean,
    /** Called when what others see changes. [online] false also records "last seen". */
    private announce: (userId: string, online: boolean) => void,
  ) {}

  isPresent(userId: string): boolean {
    return this.present.has(userId);
  }

  /** [userId]'s first connection opened. */
  connectedNow(userId: string): void {
    const pendingOffline = this.leaving.get(userId);
    if (pendingOffline) {
      // Back within the grace period: nobody saw them leave.
      clearTimeout(pendingOffline);
      this.leaving.delete(userId);
      return;
    }
    if (this.present.has(userId) || this.settling.has(userId)) return;
    if (this.timing.settleMs <= 0) {
      this.goOnline(userId);
      return;
    }
    const timer = setTimeout(() => {
      this.settling.delete(userId);
      if (this.connected(userId)) this.goOnline(userId);
    }, this.timing.settleMs);
    timer.unref?.();
    this.settling.set(userId, timer);
  }

  /** [userId]'s last connection closed. */
  disconnectedNow(userId: string): void {
    const pendingOnline = this.settling.get(userId);
    if (pendingOnline) {
      // Never announced (a wake-up fetch): nothing to take back.
      clearTimeout(pendingOnline);
      this.settling.delete(userId);
      return;
    }
    if (!this.present.has(userId) || this.leaving.has(userId)) return;
    if (this.timing.graceMs <= 0) {
      this.goOffline(userId);
      return;
    }
    const timer = setTimeout(() => {
      this.leaving.delete(userId);
      if (!this.connected(userId)) this.goOffline(userId);
    }, this.timing.graceMs);
    timer.unref?.();
    this.leaving.set(userId, timer);
  }

  /** Stops every timer (server shutdown). */
  close(): void {
    for (const t of [...this.settling.values(), ...this.leaving.values()]) clearTimeout(t);
    this.settling.clear();
    this.leaving.clear();
  }

  private goOnline(userId: string): void {
    this.present.add(userId);
    this.announce(userId, true);
  }

  private goOffline(userId: string): void {
    this.present.delete(userId);
    this.announce(userId, false);
  }
}
