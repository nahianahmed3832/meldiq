import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localParts } from "../src/modules/accounts/reminders/schedule.js";
import { currentOccurrence, nextEventStart } from "../src/modules/organizations/eventRepeat.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Batch B8b: repeating events, onboarding questions, and the community guide. */
const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

describe("event repeats", () => {
  it("keep the local time across daylight-saving changes", () => {
    // 18:00 in New York on Friday 31 October 2025; clocks go back on 2 November.
    const first = utc(2025, 10, 31, 22);
    const next = nextEventStart(first, "weekly", "America/New_York");
    expect(localParts(next, "America/New_York")).toMatchObject({ m: 11, d: 7, h: 18, mi: 0 });
    expect(next - first).toBe(7 * 86_400_000 + 3_600_000);
    expect(localParts(nextEventStart(first, "biweekly", "America/New_York"), "America/New_York")).toMatchObject({ m: 11, d: 14, h: 18 });
  });

  it("monthly is the same weekday of the month, and a missing fifth one becomes the last", () => {
    // Wednesday 15 October 2025 is the third Wednesday: the next is 19 November.
    expect(localParts(nextEventStart(utc(2025, 10, 15, 9), "monthly", "UTC"), "UTC")).toMatchObject({ m: 11, d: 19, h: 9 });
    // Wednesday 29 October 2025 is the fifth; November has four: the 26th.
    expect(localParts(nextEventStart(utc(2025, 10, 29, 9), "monthly", "UTC"), "UTC")).toMatchObject({ m: 11, d: 26 });
    // December rolls into January.
    expect(localParts(nextEventStart(utc(2025, 12, 3, 9), "monthly", "UTC"), "UTC")).toMatchObject({ y: 2026, m: 1, d: 7 });
  });

  it("yearly keeps the date, 29 February becomes the 28th", () => {
    expect(localParts(nextEventStart(utc(2028, 2, 29, 12), "yearly", "UTC"), "UTC")).toMatchObject({ y: 2029, m: 2, d: 28 });
    expect(localParts(nextEventStart(utc(2025, 10, 21, 12), "yearly", "Asia/Dhaka"), "Asia/Dhaka")).toMatchObject({ y: 2026, m: 10, d: 21 });
  });

  it("the current occurrence is the first that hasn't ended", () => {
    const start = utc(2025, 10, 1, 10);
    expect(currentOccurrence(start, 3_600_000, "weekly", "UTC", utc(2025, 10, 1, 10, 30))).toBe(start);
    expect(currentOccurrence(start, 3_600_000, "weekly", "UTC", utc(2025, 10, 20))).toBe(utc(2025, 10, 22, 10));
  });
});

let h: Harness;
let owner: GriipClient, member: GriipClient, guest: GriipClient;
let orgId: string, room: string, pub: string, secret: string, safeRole: string, adminRole: string;

beforeAll(async () => {
  h = await startServer();
  [owner, member, guest] = await Promise.all(["owner", "member", "guest"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Clubhouse" })).org.id;
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
  await member.req("POST", "/v1/invites/accept", { code });
  const g = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "GUEST" })).invite.code;
  await guest.req("POST", "/v1/invites/accept", { code: g });
  room = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "stage", voice: true })).channel.id;
  pub = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "painting" })).channel.id;
  secret = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "board", kind: "PRIVATE" })).channel.id;
  safeRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Painter", permissions: [], denies: [] })).role.id;
  adminRole = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Boss", permissions: ["members.ban"], denies: [] })).role.id;
});
afterAll(async () => h.close());

describe("repeating events", () => {
  it("are created with a repeat and move to the next occurrence when one ends", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["event-repeat", "onboarding", "community-guide"]));
    const startsAt = Date.now() + 60_000;
    const m = (await owner.req("POST", `/v1/orgs/${orgId}/meetings`, { roomId: room, title: "Club night", startsAt, endsAt: startsAt + 3_600_000, timeZone: "Asia/Dhaka", repeat: "weekly" })).meeting;
    expect(m.repeat).toBe("weekly");
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/meetings`, { roomId: room, title: "x", startsAt, endsAt: startsAt + 1000, timeZone: "UTC", repeat: "daily" }), 400);
    expect(await h.ctx.meetings.rollRepeating(startsAt + 3_600_000 + 1)).toBe(1);
    const moved = (await owner.req("GET", `/v1/meetings/${m.id}`)).meeting;
    expect(moved.startsAt).toBe(startsAt + 7 * 86_400_000);
    expect(moved.endsAt - moved.startsAt).toBe(3_600_000);
    // "none" turns repeating off.
    const off = (await owner.req("PUT", `/v1/meetings/${m.id}`, { roomId: room, title: "Club night", startsAt: moved.startsAt, endsAt: moved.endsAt, timeZone: "Asia/Dhaka", repeat: "none", rev: moved.rev })).meeting;
    expect(off.repeat).toBeNull();
    // A one-off event stays where it was.
    const once = (await owner.req("POST", `/v1/orgs/${orgId}/meetings`, { roomId: room, title: "Once", startsAt, endsAt: startsAt + 1000, timeZone: "UTC" })).meeting;
    await h.ctx.meetings.rollRepeating(startsAt + 10_000);
    expect((await owner.req("GET", `/v1/meetings/${once.id}`)).meeting).toMatchObject({ startsAt, repeat: null });
  });
});

describe("onboarding questions", () => {
  const prompts = () => [
    { title: "What brings you here?", required: true, single: true, options: [{ title: "Painting", emoji: "🎨", roleIds: [safeRole], channelIds: [pub] }, { title: "Just looking", roleIds: [], channelIds: [] }] },
  ];

  it("are set by people who edit the community; roles with admin permissions and private channels are refused", async () => {
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/onboarding`, { enabled: true, prompts: prompts() }), 403);
    expect((await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/onboarding`, { enabled: true, prompts: [{ ...prompts()[0], options: [{ title: "x", roleIds: [adminRole] }] }] }), 400)).error.code).toBe("role_not_givable");
    expect((await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/onboarding`, { enabled: true, prompts: [{ ...prompts()[0], options: [{ title: "x", channelIds: [secret] }] }] }), 400)).error.code).toBe("channel_not_public");
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/onboarding`, { enabled: true, prompts: [] }), 400);
    const saved = await owner.req("PUT", `/v1/orgs/${orgId}/onboarding`, { enabled: true, prompts: prompts() });
    expect(saved.prompts[0].options[0]).toMatchObject({ title: "Painting", emoji: "🎨", id: expect.any(String) });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.onboarding).toBe(true);
  });

  it("give the chosen answers' roles and channels; the required and one-answer rules hold", async () => {
    const q = await member.req("GET", `/v1/orgs/${orgId}/onboarding`);
    expect(q.answered).toBeNull();
    const [painting, looking] = q.prompts[0].options.map((o: { id: string }) => o.id);
    expect((await expectStatus(member.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [] }), 400)).error.code).toBe("answer_required");
    expect((await expectStatus(member.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [painting, looking] }), 400)).error.code).toBe("one_answer");
    const r = await member.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [painting] });
    expect(r.roleIds).toEqual([safeRole]);
    expect((await member.req("GET", "/v1/conversations")).conversations.map((c: { id: string }) => c.id)).toContain(pub);
    expect((await member.req("GET", `/v1/orgs/${orgId}/onboarding`)).answered).toEqual([painting]);
    // Answering differently takes back what onboarding gave, and only that.
    expect((await member.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [looking] })).roleIds).toEqual([]);
    const held = { n: h.ctx.ws.count("org_role_members", { role_id: safeRole, user_id: member.userId }) };
    expect(held.n).toBe(0);
  });

  it("never give a role that gained an admin permission later, and guests don't answer", async () => {
    const q = await member.req("GET", `/v1/orgs/${orgId}/onboarding`);
    await h.ctx.ws.write((w) => w.update("org_roles", { id: safeRole }, { permissions: JSON.stringify(["members.ban"]) }));
    expect((await member.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [q.prompts[0].options[0].id] })).roleIds).toEqual([]);
    await h.ctx.ws.write((w) => w.update("org_roles", { id: safeRole }, { permissions: "[]" }));
    await expectStatus(guest.req("POST", `/v1/orgs/${orgId}/onboarding/answers`, { optionIds: [q.prompts[0].options[0].id] }), 403);
  });
});

describe("community guide", () => {
  it("is set by people who edit the community, seen by members, and drops items whose channel is gone", async () => {
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/guide`, { welcome: "Hi", tasks: [], resources: [] }), 403);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/guide`, { welcome: "Hi", tasks: [{ title: "Say hi", channelId: "c_nowhere" }], resources: [] }), 400);
    const g = (await owner.req("PUT", `/v1/orgs/${orgId}/guide`, { welcome: "Welcome to the club!", tasks: [{ title: "Show your work", channelId: pub }], resources: [{ title: "Club board", channelId: secret }] })).guide;
    expect(g.tasks[0]).toMatchObject({ title: "Show your work", channelId: pub, id: expect.any(String) });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.guide).toMatchObject({ welcome: "Welcome to the club!", tasks: [{ channelId: pub }] });
    // B13: a private channel the member can't see isn't listed for them; the editor still sees it.
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.guide.resources).toEqual([]);
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.guide.resources).toMatchObject([{ channelId: secret }]);
    await owner.req("PATCH", `/v1/conversations/${pub}`, { archived: true });
    expect((await member.req("GET", `/v1/orgs/${orgId}`)).org.guide.tasks).toEqual([]);
    expect((await owner.req("PUT", `/v1/orgs/${orgId}/guide`, null)).guide).toBeNull();
  });
});
