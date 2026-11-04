import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Batch B4: reports to a community's moderators or to Meldiq's operators, Security actions (pausing joins and new DMs
 * between members), and the audit log's person filter.
 */
let h: Harness;
let owner: GriipClient, mod: GriipClient, member: GriipClient, other: GriipClient, outsider: GriipClient, joiner: GriipClient;
let orgId: string, general: string, dm: string, messageId: string;

const report = (c: GriipClient, body: object) => c.req("POST", "/v1/reports", body);
const queue = (c: GriipClient, status = "open") => c.req("GET", `/v1/orgs/${orgId}/reports?status=${status}`);
const invite = async () => (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;

beforeAll(async () => {
  h = await startServer();
  [owner, mod, member, other, outsider, joiner] = await Promise.all(["owner", "mod", "member", "other", "outsider", "joiner"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Safety Lab" })).org.id;
  const code = await invite();
  for (const c of [mod, member, other]) await c.req("POST", "/v1/invites/accept", { code });
  const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { template: "moderator" })).role;
  await owner.req("PUT", `/v1/roles/${role.id}/members/${mod.userId}`);
  general = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "talk", scope: "ORG" })).channel.id;
  for (const c of [member, other, mod]) await c.req("POST", `/v1/conversations/${general}/join`).catch(() => undefined);
  messageId = (await other.send(general, { type: "text", text: "rude words" })).messageId;
  dm = (await member.req("POST", "/v1/conversations/dm", { userId: other.userId })).conversation.id;
});
afterAll(async () => h.close());

describe("reports", () => {
  it("advertises the features", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["reports", "security-actions"]));
  });

  it("sends a channel message report to the community's moderators, with what the reporter shared, never who reported", async () => {
    const r = await report(member, {
      targetUserId: other.userId, conversationId: general, messageId, reason: "harassment", note: "keeps doing this",
      content: { text: "rude words", sentAt: 1, context: [{ senderUserId: member.userId, text: "please stop", sentAt: 0 }] },
    });
    expect(r.report).toMatchObject({ status: "open", to: "community", repeated: false });
    const q = await queue(mod);
    expect(q.open).toBe(1);
    expect(q.reports[0]).toMatchObject({ reason: "harassment", note: "keeps doing this", target: { id: other.userId }, conversationName: "talk", messageId });
    expect(q.reports[0].content).toMatchObject({ text: "rude words", context: [{ text: "please stop" }] });
    expect(q.reports[0]).not.toHaveProperty("reporter");
    expect(q.reports[0]).not.toHaveProperty("reporterId");
    // Sealed at rest: the stored row doesn't contain the text.
    const raw = await h.ctx.reports.get(r.report.id);
    expect(raw).not.toBeNull();
    expect(raw!.content?.startsWith("r1.")).toBe(true);
    expect(raw!.content).not.toContain("rude");
  });

  it("returns the first report when the same message is reported again", async () => {
    const again = await report(member, { targetUserId: other.userId, conversationId: general, messageId, reason: "spam" });
    expect(again.report.repeated).toBe(true);
    expect((await queue(mod)).open).toBe(1);
  });

  it("checks who may report what", async () => {
    await expectStatus(report(member, { targetUserId: member.userId, reason: "spam" }), 400);
    await expectStatus(report(member, { targetUserId: other.userId, messageId, reason: "spam" }), 400);
    await expectStatus(report(outsider, { targetUserId: other.userId, conversationId: general, messageId, reason: "spam" }), 404);
    // The server knows who sent the message: blaming someone else is refused.
    await expectStatus(report(member, { targetUserId: owner.userId, conversationId: general, messageId: (await other.send(general, { type: "text", text: "x" })).messageId, reason: "spam" }), 400);
    await expectStatus(report(member, { targetUserId: other.userId, reason: "loud" }), 400);
  });

  it("sends direct messages and illegal content to Meldiq's operators, not to moderators", async () => {
    const id = (await other.send(dm, { type: "text", text: "dm" })).messageId;
    expect((await report(member, { targetUserId: other.userId, conversationId: dm, messageId: id, reason: "harassment" })).report.to).toBe("meldiq");
    const id2 = (await other.send(general, { type: "text", text: "bad" })).messageId;
    expect((await report(member, { targetUserId: other.userId, conversationId: general, messageId: id2, reason: "illegal" })).report.to).toBe("meldiq");
    expect((await queue(mod)).open).toBe(1);
  });

  it("reports a person to the community both belong to, or to Meldiq otherwise", async () => {
    expect((await report(member, { targetUserId: other.userId, orgId, reason: "spam" })).report.to).toBe("community");
    expect((await report(member, { targetUserId: outsider.userId, orgId, reason: "spam" })).report.to).toBe("meldiq");
  });

  it("only people with reports.view see and close reports; closing is audited without content", async () => {
    await expectStatus(queue(member), 403);
    await expectStatus(queue(outsider), 404);
    const first = (await queue(mod)).reports[0];
    await expectStatus(member.req("PATCH", `/v1/reports/${first.id}`, { status: "dismissed" }), 404);
    const done = await mod.req("PATCH", `/v1/reports/${first.id}`, { status: "actioned", note: "timed out" });
    expect(done.report).toMatchObject({ status: "actioned", handledBy: { id: mod.userId }, handledNote: "timed out" });
    expect((await queue(mod, "closed")).reports.map((r: { id: string }) => r.id)).toContain(first.id);
    const audit = (await owner.req("GET", `/v1/orgs/${orgId}/audit?action=report`)).entries;
    expect(audit[0]).toMatchObject({ action: "report.actioned", target: first.id, detail: null });
  });

  it("doesn't let a moderator close a report about themselves", async () => {
    const r = await report(member, { targetUserId: mod.userId, orgId, reason: "harassment" });
    expect((await expectStatus(mod.req("PATCH", `/v1/reports/${r.report.id}`, { status: "dismissed" }), 403)).error.code).toBe("own_report");
    await owner.req("PATCH", `/v1/reports/${r.report.id}`, { status: "dismissed" });
  });

  it("limits reports to ten an hour per person", async () => {
    const already = await h.ctx.reports.countSince(member.userId, 0);
    for (let i = already; i < 10; i++) await report(member, { targetUserId: other.userId, reason: "spam" });
    expect((await expectStatus(report(member, { targetUserId: other.userId, reason: "spam" }), 429)).error.code).toBe("report_limit");
  });

  it("deletes closed reports 90 days after they were handled", async () => {
    const closed = (await queue(mod, "closed")).reports[0].id;
    const old = Date.now() - 91 * 86_400_000;
    const row = (await h.ctx.reports.get(closed))!;
    const aged = await h.ctx.reports.setStatus(closed, row.status, row.handled_by!, row.handled_note, old);
    expect(aged?.handled_at).toBe(old);
    const r = await runCleanup(h.ctx);
    expect(r.reportsPurged).toBe(1);
    expect(await h.ctx.reports.get(closed)).toBeNull();
  });
});

describe("security actions", () => {
  it("are for people who edit the community or ban members, at most 7 days ahead", async () => {
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: Date.now() + 3_600_000 }), 403);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: Date.now() + 8 * 86_400_000 }), 400);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: Date.now() - 1 }), 400);
  });

  it("pausing invites stops new members joining, says so in the preview, and resumes", async () => {
    const code = await invite();
    const until = Date.now() + 3_600_000;
    expect((await mod.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: until })).invitesPausedUntil).toBe(until);
    expect((await joiner.req("POST", "/v1/invites/preview", { code })).invitesPaused).toBe(true);
    expect((await expectStatus(joiner.req("POST", "/v1/invites/accept", { code }), 403)).error.code).toBe("invites_paused");
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org.invitesPausedUntil).toBe(until);
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: null });
    await joiner.req("POST", "/v1/invites/accept", { code });
  });

  it("pausing DMs stops new DMs between members, but not existing ones or moderators", async () => {
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { dmsPausedUntil: Date.now() + 3_600_000 });
    expect((await expectStatus(joiner.req("POST", "/v1/conversations/dm", { userId: member.userId }), 403)).error.code).toBe("dms_paused");
    expect((await member.req("POST", "/v1/conversations/dm", { userId: other.userId })).conversation.id).toBe(dm);
    await mod.req("POST", "/v1/conversations/dm", { userId: joiner.userId });
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { dmsPausedUntil: null });
    await joiner.req("POST", "/v1/conversations/dm", { userId: member.userId });
  });
});

describe("audit log filters", () => {
  it("filters by the person who made the change", async () => {
    const byMod = (await owner.req("GET", `/v1/orgs/${orgId}/audit?actorId=${mod.userId}`)).entries;
    expect(byMod.length).toBeGreaterThan(0);
    expect(byMod.every((e: { actorId: string }) => e.actorId === mod.userId)).toBe(true);
  });
});
