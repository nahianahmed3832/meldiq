import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isValidTimeZone, localParts, nextOccurrence, retryDelayMs, zonedToUtc } from "../src/modules/accounts/reminders/schedule.js";
import { canonical, GriipClient, sign } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sealed = (n = 0) => `c2VhbGVkLXJlbWluZGVyLWNvbnRlbnQ${"A".repeat(8 + n)}`;
let seq = 0;
const rid = () => `rem_${Date.now().toString(36)}_${++seq}`;

describe("reminder times", () => {
  it("knows IANA zones and refuses made-up ones", () => {
    expect(isValidTimeZone("Asia/Dhaka")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("converts local wall-clock times to UTC, including across daylight saving", () => {
    // Dhaka is UTC+6 all year.
    expect(zonedToUtc({ y: 2026, m: 10, d: 19 }, 9, 0, "Asia/Dhaka")).toBe(Date.UTC(2026, 9, 19, 3, 0));
    // New York: EDT (UTC−4) in July, EST (UTC−5) in December.
    expect(zonedToUtc({ y: 2026, m: 7, d: 1 }, 9, 0, "America/New_York")).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(zonedToUtc({ y: 2026, m: 12, d: 1 }, 9, 0, "America/New_York")).toBe(Date.UTC(2026, 11, 1, 14, 0));
    // 02:30 doesn't exist on 2026-03-08 in New York (clocks jump 02:00 → 03:00): it lands just after the gap.
    const gap = zonedToUtc({ y: 2026, m: 3, d: 8 }, 2, 30, "America/New_York");
    expect(localParts(gap, "America/New_York").h).toBe(3);
  });

  it("keeps a daily reminder at the same local time across a clock change", () => {
    // London leaves summer time on Sunday 25 October 2026: Saturday's 09:00 is 08:00 UTC, Sunday's is 09:00 UTC.
    const rule = { recurrence: "daily" as const, localTime: "09:00", anchorDate: "2026-10-01", timeZone: "Europe/London" };
    const before = nextOccurrence(rule, Date.UTC(2026, 9, 24, 0));
    const after = nextOccurrence(rule, before);
    expect(before).toBe(Date.UTC(2026, 9, 24, 8, 0));
    expect(after).toBe(Date.UTC(2026, 9, 25, 9, 0));
    for (const t of [before, after]) {
      const l = localParts(t, "Europe/London");
      expect([l.h, l.mi]).toEqual([9, 0]);
    }
    expect(after - before).toBe(25 * HOUR);
    // Across the spring change (29 March 2026) the gap between two 09:00s is 23 hours.
    const spring = { ...rule, anchorDate: "2026-03-01" };
    const sat = nextOccurrence(spring, Date.UTC(2026, 2, 28, 0));
    const sun = nextOccurrence(spring, sat);
    expect(sun - sat).toBe(23 * HOUR);
    expect(localParts(sun, "Europe/London").h).toBe(9);
  });

  it("skips weekends for weekday reminders and repeats weekly and monthly on the anchor", () => {
    const tz = "Asia/Dhaka";
    // Friday 23 Oct 2026, after 09:00 local: the next weekday reminder is Monday 26 Oct.
    const fri = zonedToUtc({ y: 2026, m: 10, d: 23 }, 10, 0, tz);
    const next = nextOccurrence({ recurrence: "weekdays", localTime: "09:00", anchorDate: "2026-10-01", timeZone: tz }, fri);
    expect(localParts(next, tz)).toMatchObject({ y: 2026, m: 10, d: 26, h: 9, mi: 0 });
    // Weekly from Tuesday 20 Oct: the next is Tuesday 27 Oct.
    const weekly = nextOccurrence({ recurrence: "weekly", localTime: "14:30", anchorDate: "2026-10-20", timeZone: tz }, zonedToUtc({ y: 2026, m: 10, d: 21 }, 0, 0, tz));
    expect(localParts(weekly, tz)).toMatchObject({ m: 10, d: 27, h: 14, mi: 30 });
    // Monthly on the 31st: November has 30 days, so it falls on the 30th.
    const monthly = nextOccurrence({ recurrence: "monthly", localTime: "08:00", anchorDate: "2026-10-31", timeZone: tz }, zonedToUtc({ y: 2026, m: 11, d: 1 }, 0, 0, tz));
    expect(localParts(monthly, tz)).toMatchObject({ m: 11, d: 30, h: 8 });
    // Never before the anchor date.
    const anchored = nextOccurrence({ recurrence: "daily", localTime: "08:00", anchorDate: "2026-12-01", timeZone: tz }, Date.UTC(2026, 9, 1));
    expect(localParts(anchored, tz)).toMatchObject({ m: 12, d: 1, h: 8 });
  });

  it("backs off retries exponentially up to an hour", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(20)).toBe(HOUR);
  });
});

/** A second device of [c]'s identity (the same steps as test/messaging.test.ts). */
async function secondDevice(c: GriipClient): Promise<GriipClient> {
  const d = new GriipClient(c.baseUrl, c.username);
  d.identity = c.identity;
  const { nonce } = await d.req("POST", "/v1/auth/challenge");
  const r = await d.req("POST", "/v1/auth/add-device", {
    username: c.username,
    device: { name: "tablet", signingKey: d.signingKeyB64, encryptionKey: d.encKeyB64, certificate: d.certificate() },
    nonce,
    signature: sign(d.device, canonical.authProof("add-device", nonce, d.signingKeyB64)),
  });
  Object.assign(d, { userId: r.userId, deviceId: r.deviceId, token: r.sessionToken });
  return d;
}

describe("reminders API", () => {
  let h: Harness;
  let alice: GriipClient, alice2: GriipClient, bob: GriipClient;

  beforeAll(async () => {
    h = await startServer({ REMINDER_TICK_MS: "0" });
    [alice, bob] = await Promise.all(["alice", "bob"].map((n) => h.client(n)));
    alice2 = await secondDevice(alice);
  });
  afterAll(async () => h.close());

  const create = (c: GriipClient, body: Record<string, unknown>) => c.req("POST", "/v1/reminders", { id: rid(), sealed: sealed(), timeZone: "Asia/Dhaka", ...body });

  it("advertises the feature", async () => {
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("reminders");
  });

  it("creates, lists and syncs reminders between the person's devices only", async () => {
    await alice2.connect();
    const due = Date.now() + HOUR;
    const { reminder } = await create(alice, { dueAt: due });
    expect(reminder).toMatchObject({ dueAt: due, state: "scheduled", repeat: null, rev: 1, sealed: sealed() });
    await alice2.waitFor(() => alice2.events.find((e) => e.t === "reminders.changed" && e.id === reminder.id));
    expect((await alice2.req("GET", "/v1/reminders")).reminders.map((r: { id: string }) => r.id)).toContain(reminder.id);
    // Someone else's reminder doesn't exist for bob.
    await expectStatus(bob.req("GET", `/v1/reminders/${reminder.id}`), 404);
    await expectStatus(bob.req("PATCH", `/v1/reminders/${reminder.id}`, { rev: 1, state: "done" }), 404);
    await expectStatus(bob.req("DELETE", `/v1/reminders/${reminder.id}`), 404);
    expect((await bob.req("GET", "/v1/reminders")).reminders).toEqual([]);
    await alice2.disconnect();
  });

  it("treats a retried create with the same id as the same reminder", async () => {
    const id = rid();
    const body = { id, sealed: sealed(), dueAt: Date.now() + HOUR, timeZone: "UTC" };
    const a = await alice.req("POST", "/v1/reminders", body);
    const b = await alice.req("POST", "/v1/reminders", body);
    expect(b.reminder).toEqual(a.reminder);
    await expectStatus(bob.req("POST", "/v1/reminders", body), 409);
  });

  it("refuses bad input: unknown zones, seconds instead of milliseconds, setting 'fired' by hand", async () => {
    await expectStatus(create(alice, { dueAt: Date.now() + HOUR, timeZone: "Mars/Olympus" }), 400);
    await expectStatus(create(alice, { dueAt: Math.floor(Date.now() / 1000) }), 400);
    await expectStatus(create(alice, { dueAt: Date.now() + HOUR, sealed: "not base64 url!" }), 400);
    const { reminder } = await create(alice, { dueAt: Date.now() + HOUR });
    await expectStatus(alice.req("PATCH", `/v1/reminders/${reminder.id}`, { rev: reminder.rev, state: "fired" }), 400);
  });

  it("detects edits from two devices with the revision", async () => {
    const { reminder } = await create(alice, { dueAt: Date.now() + HOUR });
    await alice.req("PATCH", `/v1/reminders/${reminder.id}`, { rev: 1, sealed: sealed(1) });
    const stale = await expectStatus(alice2.req("PATCH", `/v1/reminders/${reminder.id}`, { rev: 1, sealed: sealed(2) }), 409);
    expect(stale.error.code).toBe("stale_reminder");
    expect(stale.error.details.current.sealed).toBe(sealed(1));
  });

  it("fires a due one-off reminder once, then it is overdue until done; dismissing doesn't make it done", async () => {
    await alice.connect();
    const { reminder } = await create(alice, { dueAt: Date.now() + 60_000 });
    expect((await h.ctx.reminders.tick()).fired).toBe(0); // not due yet
    const at = reminder.dueAt + 1;
    expect((await h.ctx.reminders.tick(at)).fired).toBe(1);
    expect((await h.ctx.reminders.tick(at + 1000)).fired).toBe(0); // never twice
    const due = await alice.waitFor(() => alice.events.find((e) => e.t === "reminder.due" && e.id === reminder.id));
    expect(due).toEqual({ t: "reminder.due", id: reminder.id, occurrenceAt: reminder.dueAt, firedAt: at });
    // The event carries no content; the sealed copy stays where it was.
    expect(JSON.stringify(due)).not.toContain(sealed());
    const fired = (await alice.req("GET", "/v1/reminders?state=fired")).reminders.find((r: { id: string }) => r.id === reminder.id);
    expect(fired).toMatchObject({ state: "fired", firedAt: at, deliveredAt: null });
    await alice.req("POST", `/v1/reminders/${reminder.id}/ack`, { firedAt: at });
    expect((await alice.req("GET", `/v1/reminders/${reminder.id}`)).reminder.deliveredAt).not.toBeNull();
    const dismissed = await alice.req("PATCH", `/v1/reminders/${reminder.id}`, { rev: fired.rev, state: "dismissed" });
    expect(dismissed.reminder).toMatchObject({ state: "dismissed" });
    expect(dismissed.reminder.completedAt).not.toBeNull();
    await alice.disconnect();
  });

  it("snoozes by moving the due time, which schedules it again", async () => {
    const { reminder } = await create(alice, { dueAt: Date.now() + 1000 });
    await h.ctx.reminders.tick(reminder.dueAt + 1);
    const fired = (await alice.req("GET", `/v1/reminders/${reminder.id}`)).reminder;
    expect(fired.state).toBe("fired");
    const later = reminder.dueAt + 10 * 60_000;
    const snoozed = await alice.req("PATCH", `/v1/reminders/${reminder.id}`, { rev: fired.rev, dueAt: later });
    expect(snoozed.reminder).toMatchObject({ state: "scheduled", dueAt: later });
    expect((await h.ctx.reminders.tick(later + 1)).fired).toBe(1);
  });

  it("moves a repeating reminder to its next occurrence instead of replaying missed ones", async () => {
    const tz = "Asia/Dhaka";
    const now = Date.now();
    const today = localParts(now, tz);
    const anchorDate = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
    const { reminder } = await create(alice, { dueAt: now, timeZone: tz, repeat: { recurrence: "daily", localTime: "09:00", anchorDate } });
    expect(localParts(reminder.dueAt, tz)).toMatchObject({ h: 9, mi: 0 });
    expect(reminder.dueAt).toBeGreaterThan(now);
    // The server was "down" for three days: one fire, then the next 09:00 after that moment.
    const late = reminder.dueAt + 3 * DAY + HOUR;
    await h.ctx.reminders.tick(late);
    await h.ctx.reminders.tick(late + 1000);
    const occurrences = { n: h.ctx.identity.count("reminder_occurrences", { reminder_id: reminder.id }) };
    expect(occurrences.n).toBe(1);
    const moved = (await alice.req("GET", `/v1/reminders/${reminder.id}`)).reminder;
    expect(moved.state).toBe("scheduled");
    expect(moved.dueAt).toBeGreaterThan(late);
    expect(moved.dueAt - late).toBeLessThanOrEqual(DAY);
    expect(localParts(moved.dueAt, tz)).toMatchObject({ h: 9, mi: 0 });
  });

  it("retries a failed delivery with backoff and gives up after eight attempts", async () => {
    const { reminder } = await create(alice, { dueAt: Date.now() + 1000 });
    const realFire = (h.ctx.reminders as unknown as { fire: (...a: unknown[]) => void }).fire;
    (h.ctx.reminders as unknown as { fire: () => void }).fire = () => {
      throw new Error("database is locked");
    };
    try {
      let t = reminder.dueAt + 1;
      const first = await h.ctx.reminders.tick(t);
      expect(first).toMatchObject({ retried: 1, fired: 0 });
      let row = (await alice.req("GET", `/v1/reminders/${reminder.id}`)).reminder;
      expect(row.state).toBe("scheduled");
      // Not retried before its backoff is over.
      expect((await h.ctx.reminders.tick(t + 1000)).retried).toBe(0);
      for (let i = 2; i <= 8; i++) {
        t += retryDelayMs(i - 1) + 1;
        await h.ctx.reminders.tick(t);
      }
      row = (await alice.req("GET", `/v1/reminders/${reminder.id}`)).reminder;
      expect(row).toMatchObject({ state: "fired", delivery: "failed" });
    } finally {
      (h.ctx.reminders as unknown as { fire: unknown }).fire = realFire;
    }
  });

  it("deletes on request", async () => {
    const { reminder } = await create(bob, { dueAt: Date.now() + HOUR });
    await bob.req("DELETE", `/v1/reminders/${reminder.id}`);
    await expectStatus(bob.req("GET", `/v1/reminders/${reminder.id}`), 404);
  });
});
