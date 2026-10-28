import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountClient, MemoryMailer } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Round 3 (docs/product/MELDIQ_3_REFERENCE_MATRIX.md): statuses with an emoji and an end time, pausing notifications,
// and how many of a conversation's members are online. Test accounts on a throwaway server only.
let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({ REMINDER_TICK_MS: "0" }, { mailer });
});
afterAll(async () => h.close());

const HOUR = 3_600_000;
const pair = async (a: string, b: string) => {
  const ada = await AccountClient.ready(h.baseUrl, mailer, a);
  const bob = await AccountClient.ready(h.baseUrl, mailer, b);
  const dm = (await ada.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  return { ada, bob, dm };
};
const memberOf = async (viewer: AccountClient, conv: string, userId: string) =>
  ((await viewer.req("GET", `/v1/conversations/${conv}`)).conversation.members as any[]).find((m) => m.id === userId);

describe("statuses", () => {
  it("are advertised", async () => {
    const info = await (await fetch(`${h.baseUrl}/v1/server-info`)).json();
    expect(info.features).toEqual(expect.arrayContaining(["status-expiry", "notifications-pause", "conversation-presence"]));
  });

  it("carry an emoji and an end time, and disappear for everyone once it passes", async () => {
    const { ada, bob, dm } = await pair("statusada", "statusbob");
    const until = Date.now() + HOUR;
    const me = (await ada.req("PATCH", "/v1/users/me", { statusText: "In a meeting", statusEmoji: "📅", statusExpiresAt: until })).user;
    expect(me).toMatchObject({ statusText: "In a meeting", statusEmoji: "📅", statusExpiresAt: until });
    expect(await memberOf(bob, dm, ada.userId)).toMatchObject({ statusText: "In a meeting", statusEmoji: "📅" });

    // Its end time passes (written directly: the server checks the time on every read).
    await h.ctx.identity.write((w) => w.update("users", { id: ada.userId }, { status_expires_at: Date.now() - 1 }));
    const after = (await ada.req("GET", "/v1/users/me")).user;
    expect(after.statusText).toBeUndefined();
    expect(after.statusEmoji).toBeUndefined();
    expect(await memberOf(bob, dm, ada.userId)).toMatchObject({ statusText: null, statusEmoji: null });
  });

  it("refuse an end time in the past or beyond a year, and emoji with letters; a new status drops the old end time", async () => {
    const c = await AccountClient.ready(h.baseUrl, mailer, "statusrules");
    await expectStatus(c.req("PATCH", "/v1/users/me", { statusText: "Out sick", statusExpiresAt: Date.now() - 1000 }), 400);
    await expectStatus(c.req("PATCH", "/v1/users/me", { statusText: "Away", statusExpiresAt: Date.now() + 400 * 24 * HOUR }), 400);
    await expectStatus(c.req("PATCH", "/v1/users/me", { statusEmoji: "abc" }), 400);
    await c.req("PATCH", "/v1/users/me", { statusText: "Commuting", statusEmoji: "🚌", statusExpiresAt: Date.now() + HOUR });
    const plain = (await c.req("PATCH", "/v1/users/me", { statusText: "Working remotely" })).user;
    expect(plain.statusText).toBe("Working remotely");
    expect(plain.statusExpiresAt).toBeUndefined();
    // Changing another field leaves the status and its end time alone.
    const until = Date.now() + HOUR;
    await c.req("PATCH", "/v1/users/me", { statusText: "Vacationing", statusExpiresAt: until });
    expect((await c.req("PATCH", "/v1/users/me", { firstName: "Rafi" })).user).toMatchObject({ statusText: "Vacationing", statusExpiresAt: until });
    const cleared = (await c.req("PATCH", "/v1/users/me", { statusText: null, statusEmoji: null })).user;
    expect([cleared.statusText, cleared.statusEmoji, cleared.statusExpiresAt]).toEqual([undefined, undefined, undefined]);
  });
});

describe("pausing notifications", () => {
  it("is kept for the person, shown to people who may see their last-seen time, and can be ended", async () => {
    const { ada, bob, dm } = await pair("pauseada", "pausebob");
    const until = Date.now() + 8 * HOUR;
    expect((await ada.req("PATCH", "/v1/users/me", { notificationsPausedUntil: until })).user.notificationsPausedUntil).toBe(until);
    expect((await memberOf(bob, dm, ada.userId)).notificationsPaused).toBe(true);
    await expectStatus(ada.req("PATCH", "/v1/users/me", { notificationsPausedUntil: Date.now() + 31 * 24 * HOUR }), 400);

    // Ada hides her last-seen time: Bob no longer learns that she paused notifications.
    await ada.req("PUT", "/v1/users/me/privacy", { lastSeen: "nobody" });
    expect((await memberOf(bob, dm, ada.userId)).notificationsPaused).toBeNull();
    await ada.req("PUT", "/v1/users/me/privacy", { lastSeen: "contacts" });

    expect((await ada.req("PATCH", "/v1/users/me", { notificationsPausedUntil: null })).user.notificationsPausedUntil).toBeNull();
    expect((await memberOf(bob, dm, ada.userId)).notificationsPaused).toBe(false);
  });
});

describe("who is online in a conversation", () => {
  it("counts online members for members only, leaving out people who hide their online state", async () => {
    const { ada, bob, dm } = await pair("presada", "presbob");
    const outsider = await AccountClient.ready(h.baseUrl, mailer, "presout");
    await expectStatus(outsider.req("GET", `/v1/conversations/${dm}/presence`), 404);
    expect(await ada.req("GET", `/v1/conversations/${dm}/presence`)).toEqual({ online: 0, members: 2 });

    await bob.connect();
    try {
      let seen = 0;
      for (let i = 0; i < 50 && seen !== 1; i++) {
        seen = (await ada.req("GET", `/v1/conversations/${dm}/presence`)).online;
        if (seen !== 1) await new Promise((r) => setTimeout(r, 100));
      }
      expect(seen).toBe(1);
      await bob.req("PUT", "/v1/users/me/privacy", { lastSeen: "nobody" });
      expect(await ada.req("GET", `/v1/conversations/${dm}/presence`)).toEqual({ online: 0, members: 2 });
      // Bob still counts himself.
      expect((await bob.req("GET", `/v1/conversations/${dm}/presence`)).online).toBe(1);
    } finally {
      await bob.disconnect();
    }
  });
});
