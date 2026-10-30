import { checkAlerts } from "./alerts.js";
import { dueGiveaways, endGiveaway } from "./giveaways.js";
import type { OfficialBots } from "./runtime.js";
import { postRecaps } from "./wordy.js";

const MINUTE_MS = 60_000;
/** How often Alerts looks for new uploads (each look costs one YouTube quota unit per followed channel). */
export const ALERTS_EVERY_MS = 10 * MINUTE_MS;
/** A wake-up a little after a giveaway's end, so it's surely due when the tick reads it. */
const WAKE_SLACK_MS = 50;

/**
 * What official bots do on their own (community parity batch D part 2). Nothing is held in memory that a restart would
 * lose: every minute (and once at startup) the tick ends the giveaways whose stored end time has passed and posts
 * Wordy's recap of yesterday where it's due (claimed in its table, so it goes once); a giveaway ending sooner than the
 * next tick gets a timer of its own. Alerts looks for new uploads every ten minutes, off the event queue, since it waits
 * on YouTube. Ticks run on the bots' event queue, so they never interleave with a bot handling a message.
 */
export class BotScheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly wakeups = new Set<NodeJS.Timeout>();
  private alertsRun: Promise<void> | null = null;

  constructor(private readonly rt: OfficialBots) {}

  start(): void {
    if (!this.rt.enabled || this.timers.length) return;
    void this.tick(this.rt.clock());
    const minute = setInterval(() => void this.tick(this.rt.clock()), MINUTE_MS);
    const alerts = setInterval(() => void this.checkAlerts(this.rt.clock()), ALERTS_EVERY_MS);
    minute.unref();
    alerts.unref();
    this.timers = [minute, alerts];
  }

  async stop(): Promise<void> {
    for (const t of [...this.timers, ...this.wakeups]) clearTimeout(t);
    this.timers = [];
    this.wakeups.clear();
    await this.alertsRun;
  }

  /** Something is due at [at]: when that's before the next minute's tick, a timer of its own runs the tick then. */
  wake(at: number): void {
    const ms = at - this.rt.clock();
    if (!this.timers.length || ms > MINUTE_MS) return;
    const t = setTimeout(() => {
      this.wakeups.delete(t);
      void this.tick(this.rt.clock());
    }, Math.max(ms, 0) + WAKE_SLACK_MS);
    t.unref();
    this.wakeups.add(t);
  }

  /** Ends the giveaways due by [at] and posts the Wordy recaps due then. Resolves once that's done. */
  tick(at: number): Promise<void> {
    return this.rt.later("tick", async () => {
      for (const g of dueGiveaways(this.rt, at)) {
        try {
          await endGiveaway(this.rt, g, at);
        } catch (err) {
          this.rt.ctx.log.warn({ err, giveawayId: g.id, orgId: g.org_id }, "official bots: giveaway not ended");
        }
      }
      await postRecaps(this.rt, at);
    });
  }

  /** Looks for new uploads of every followed channel (one look at a time). */
  checkAlerts(at: number): Promise<void> {
    if (!this.alertsRun) {
      this.alertsRun = checkAlerts(this.rt, at)
        .then(() => undefined)
        .catch((err) => this.rt.ctx.log.warn({ err }, "official bots: alerts check failed"))
        .finally(() => {
          this.alertsRun = null;
        });
    }
    return this.alertsRun;
  }
}
