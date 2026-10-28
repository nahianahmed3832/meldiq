import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Batch B3 (docs/product/MELDIQ_IMPLEMENTATION_PLAN.md): slowmode enforced by the server for new messages; and, in the
 * person's preferences, mutes that end by themselves, a level per category, and channels hidden from the list.
 */
let h: Harness;
let owner: GriipClient, member: GriipClient, helper: GriipClient, outsider: GriipClient;
let orgId: string, otherOrg: string, general: string, quiet: string, privateCh: string, dm: string, category: string, otherCategory: string;

const prefsOf = (c: GriipClient, ws: string) => c.req("GET", `/v1/me/preferences/${ws}`);
const put = (c: GriipClient, ws: string, baseRev: number, prefs: object) => c.req("PUT", `/v1/me/preferences/${ws}`, { baseRev, prefs });
const post = (c: GriipClient, conv: string, messageId?: string) => c.send(conv, { type: "text", text: "hello" }, "message", messageId);
const view = async (c: GriipClient, conv: string) => (await c.req("GET", `/v1/conversations/${conv}`)).conversation;
/** Moves [who]'s last post in [conv] back by [ms], as if time had passed. */
const age = (who: GriipClient, conv: string, ms: number) =>
  h.ctx.ws.write((w) => {
    const key = { conversation_id: conv, user_id: who.userId };
    const last = w.get<{ last_post_at: number | null }>("conversation_members", key)?.last_post_at;
    if (last != null) w.update("conversation_members", key, { last_post_at: last - ms });
  });

beforeAll(async () => {
  h = await startServer();
  [owner, member, helper, outsider] = await Promise.all(["owner", "member", "helper", "outsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Controls Lab" })).org.id;
  otherOrg = (await outsider.req("POST", "/v1/orgs", { name: "Elsewhere" })).org.id;
  for (const c of [member, helper]) {
    const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
  }
  category = (await owner.req("POST", `/v1/orgs/${orgId}/categories`, { name: "Talk" })).category.id;
  otherCategory = (await outsider.req("POST", `/v1/orgs/${otherOrg}/categories`, { name: "Theirs" })).category.id;
  general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "slow", scope: "ORG", categoryId: category })).channel.id;
  quiet = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "quiet", scope: "ORG", autoJoin: false })).channel.id;
  privateCh = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "secret", scope: "ORG", kind: "PRIVATE" })).channel.id;
  for (const c of [member, helper]) await c.req("POST", `/v1/conversations/${general}/join`).catch(() => undefined);
  dm = (await member.req("POST", "/v1/conversations/dm", { userId: helper.userId })).conversation.id;
});
afterAll(async () => h.close());

describe("slowmode", () => {
  it("advertises the features", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["slowmode", "channel-preferences"]));
  });

  it("is set by people who manage the channel, to one of the offered intervals, on channels only", async () => {
    await expectStatus(member.req("PATCH", `/v1/conversations/${general}`, { slowmodeSec: 30 }), 403);
    await expectStatus(owner.req("PATCH", `/v1/conversations/${general}`, { slowmodeSec: 7 }), 400);
    await expectStatus(member.req("PATCH", `/v1/conversations/${dm}`, { slowmodeSec: 30 }), 403);
    const r = await owner.req("PATCH", `/v1/conversations/${general}`, { slowmodeSec: 30 });
    expect(r.conversation.slowmodeSec).toBe(30);
    expect((await view(member, general)).slowmodeSec).toBe(30);
  });

  it("lets a member post once per interval, says when they can post again, and keeps edits and reactions free", async () => {
    await post(member, general);
    const refused = await expectStatus(post(member, general), 429);
    expect(refused.error.code).toBe("slowmode");
    expect(refused.error.details.retryAfter).toBeGreaterThan(25);
    expect(refused.error.details.retryAfter).toBeLessThanOrEqual(30);
    // The person's own view says when.
    const v = await view(member, general);
    expect(v.slowmodeExempt).toBe(false);
    expect(v.nextPostAt).toBeGreaterThan(Date.now());
    // Controls (edits, reactions, votes) aren't new messages.
    await member.send(general, { type: "reaction", target: "m_x", emoji: "👍", add: true }, "control");
    // After the interval the next message goes through.
    await age(member, general, 31_000);
    await post(member, general);
  });

  it("returns a retry of an accepted message as a duplicate, never as a slowmode refusal", async () => {
    await age(member, general, 31_000);
    const id = crypto.randomUUID();
    await post(member, general, id);
    const again = await post(member, general, id);
    expect(again.duplicate).toBe(true);
  });

  it("doesn't slow down channel managers or holders of messages.bypass_slowmode", async () => {
    await post(owner, general);
    await post(owner, general);
    expect((await view(owner, general)).slowmodeExempt).toBe(true);
    const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { name: "Regulars", permissions: ["messages.bypass_slowmode"] })).role;
    await owner.req("PUT", `/v1/roles/${role.id}/members/${helper.userId}`);
    await post(helper, general);
    await post(helper, general);
    expect((await view(helper, general)).slowmodeExempt).toBe(true);
  });

  it("turns off", async () => {
    await owner.req("PATCH", `/v1/conversations/${general}`, { slowmodeSec: 0 });
    await age(member, general, 0);
    await post(member, general);
    await post(member, general);
    expect((await view(member, general)).nextPostAt).toBeNull();
  });
});

describe("channel preferences", () => {
  it("keeps mutes that haven't ended, for the person's own conversations only, in any document", async () => {
    const soon = Date.now() + 3_600_000;
    const p = await prefsOf(member, orgId);
    const r = await put(member, orgId, p.rev, { mutedUntil: { [general]: soon, [privateCh]: soon, [quiet]: Date.now() - 1000 } });
    expect(r.prefs.mutedUntil).toEqual({ [general]: soon });
    // DMs live in the personal document.
    const personal = await prefsOf(member, "personal");
    expect((await put(member, "personal", personal.rev, { mutedUntil: { [dm]: soon } })).prefs.mutedUntil).toEqual({ [dm]: soon });
  });

  it("keeps a level per category of this community, and an explicit 'all' under a quieter category", async () => {
    const p = await prefsOf(member, orgId);
    const r = await put(member, orgId, p.rev, {
      categoryNotify: { [category]: "none", [otherCategory]: "mentions" },
      notify: { [general]: "all" },
    });
    expect(r.prefs.categoryNotify).toEqual({ [category]: "none" });
    expect(r.prefs.notify).toEqual({ [general]: "all" });
    // Category back to following the community: the "all" override says nothing any more.
    const back = await put(member, orgId, r.rev, { categoryNotify: {}, notify: { [general]: "all" } });
    expect(back.prefs.notify).toEqual({});
    await expectStatus(put(member, orgId, back.rev, { categoryNotify: { [category]: "loud" } }), 400);
  });

  it("hides channels of this community the person can see, joined or not", async () => {
    const p = await prefsOf(member, orgId);
    const r = await put(member, orgId, p.rev, { hidden: [quiet, general, privateCh, dm, quiet] });
    expect(r.prefs.hidden).toEqual([quiet, general]);
  });

  it("keeps all three when an older app writes without them, and drops the community ones from the personal document", async () => {
    const soon = Date.now() + 3_600_000;
    const p = await prefsOf(member, orgId);
    const set = await put(member, orgId, p.rev, { mutedUntil: { [general]: soon }, categoryNotify: { [category]: "mentions" }, hidden: [quiet] });
    const older = await put(member, orgId, set.rev, { starred: [] });
    expect(older.prefs).toMatchObject({ mutedUntil: { [general]: soon }, categoryNotify: { [category]: "mentions" }, hidden: [quiet] });
    const personal = await prefsOf(member, "personal");
    const r = await put(member, "personal", personal.rev, { categoryNotify: { [category]: "none" }, hidden: [quiet] });
    expect(r.prefs.categoryNotify).toBeUndefined();
    expect(r.prefs.hidden).toBeUndefined();
  });
});
