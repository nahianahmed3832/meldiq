import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/modules/administration/jobs.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Round 7 slice C5 (docs/WORKSPACE_C5.md): guest end dates and policy, and meetings (community events in the app). */
let h: Harness;
let owner: GriipClient, member: GriipClient, member2: GriipClient, guest: GriipClient, outsider: GriipClient;
let orgId: string;

const join = async (c: GriipClient, role = "MEMBER", extra: object = {}) => {
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role, ...extra })).invite.code;
  await c.req("POST", "/v1/invites/accept", { code });
};
const myChannels = async (c: GriipClient) => ((await c.req("GET", "/v1/conversations")).conversations as { id: string; name: string; type: string }[]).filter((x) => x.type === "CHANNEL");
const expiresOf = (c: GriipClient) => h.ctx.ws.get<{ expires_at: number | null }>("org_members", { org_id: orgId, user_id: c.userId })?.expires_at;

beforeAll(async () => {
  h = await startServer({ WORKFLOW_TICK_MS: "0" });
  [owner, member, member2, guest, outsider] = await Promise.all(["c5owner", "c5member", "c5member2", "c5guest", "c5outsider"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Five Co" })).org.id;
  await join(member);
  await join(member2);
  await join(guest, "GUEST");
});
afterAll(async () => h.close());

describe("guests", () => {
  it("a guest invitation's end date applies when they join; admins can change it within the policy", async () => {
    const g2 = await h.client("c5guest2");
    const before = Date.now();
    await join(g2, "GUEST", { guestDays: 7 });
    expect(expiresOf(g2)).toBeGreaterThan(before + 6.9 * 86_400_000);
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", guestDays: 3 }), 400);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/members/${member.userId}/expiry`, { expiresAt: Date.now() + 86_400_000 }), 400);
    await owner.req("PUT", `/v1/orgs/${orgId}/members/${g2.userId}/expiry`, { expiresAt: null });
    expect(expiresOf(g2)).toBeNull();
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/members/${g2.userId}/expiry`, { expiresAt: null }), 403);
  });

  it("the policy caps or refuses guest invitations and brings end dates forward", async () => {
    await owner.req("PUT", `/v1/orgs/${orgId}/guest-policy`, { guestsAllowed: true, guestMaxDays: 3 });
    const capped = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "GUEST", guestDays: 30 })).invite;
    expect(capped.guestDays).toBe(3);
    expect(expiresOf(guest)).toBeLessThanOrEqual(Date.now() + 3 * 86_400_000 + 1000);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/members/${guest.userId}/expiry`, { expiresAt: null }), 409);
    await owner.req("PUT", `/v1/orgs/${orgId}/guest-policy`, { guestsAllowed: false, guestMaxDays: null });
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "GUEST" }), 409);
    expect((await owner.req("GET", `/v1/orgs/${orgId}`)).org).toMatchObject({ guestsAllowed: false, guestMaxDays: null });
    await owner.req("PUT", `/v1/orgs/${orgId}/guest-policy`, { guestsAllowed: true, guestMaxDays: null });
  });

  it("a guest past their end date is taken out by the retention job, like a removal", async () => {
    const g3 = await h.client("c5guest3");
    await join(g3, "GUEST", { guestDays: 1 });
    await h.ctx.ws.write((w) => w.update("org_members", { org_id: orgId, user_id: g3.userId }, { expires_at: Date.now() - 1000 }));
    const r = await runCleanup(h.ctx);
    expect(r.guestsExpired).toBeGreaterThanOrEqual(1);
    await expectStatus(g3.req("GET", `/v1/orgs/${orgId}`), 404);
    const audit = h.ctx.ws.get<{ action: string }>("audit_log", { org_id: orgId, target: g3.userId }, [["id", "desc"]])!;
    expect(audit.action).toBe("member.expire");
  });
});

describe("meetings", () => {
  let room: string, privateRoom: string, text: string, meetingId: string;
  const at = (minutes: number) => Date.now() + minutes * 60_000;

  beforeAll(async () => {
    room = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "boardroom", scope: "ORG", kind: "PUBLIC", voice: true })).channel.id;
    privateRoom = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "exec-room", scope: "ORG", kind: "PRIVATE", voice: true })).channel.id;
    text = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "chatter", scope: "ORG", kind: "PUBLIC" })).channel.id;
  });

  const body = (extra: object = {}) => ({ roomId: room, title: "Weekly sync", startsAt: at(60), endsAt: at(90), timeZone: "Asia/Dhaka", participantIds: [member.userId], ...extra });

  it("happens in a voice room, never a text channel; everyone invited must be able to open it", async () => {
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ roomId: text })), 400);
    const refused = await owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ roomId: privateRoom })).catch((e: Error) => e.message);
    expect(String(refused)).toContain("can't open that voice room");
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ startsAt: at(-60), endsAt: at(-30) })), 400);
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ endsAt: at(30) })), 400);
    await expectStatus(owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ groupIds: ["g_old"] })), 400);
    await expectStatus(guest.req("POST", `/v1/orgs/${orgId}/meetings`, body()), 403);
    meetingId = (await owner.req("POST", `/v1/orgs/${orgId}/meetings`, body())).meeting.id;
  });

  it("people invited respond; a private room's meeting stays hidden from people who can't open the room", async () => {
    const m = (await member.req("POST", `/v1/meetings/${meetingId}/respond`, { response: "accepted" })).meeting;
    expect(m.myResponse).toBe("accepted");
    const secret = (await owner.req("POST", `/v1/orgs/${orgId}/meetings`, { ...body({ roomId: privateRoom, participantIds: [] }), title: "Exec only" })).meeting.id;
    await expectStatus(member.req("GET", `/v1/meetings/${secret}`), 404);
    expect((await member.req("GET", `/v1/orgs/${orgId}/meetings`)).meetings.map((x: { id: string }) => x.id)).not.toContain(secret);
    await expectStatus(outsider.req("GET", `/v1/meetings/${meetingId}`), 404);
    await expectStatus(member.req("POST", `/v1/meetings/${secret}/respond`, { response: "accepted" }), 404);
  });

  it("a new time asks everyone again; only the organizer or room managers change or cancel it", async () => {
    const cur = (await owner.req("GET", `/v1/meetings/${meetingId}`)).meeting;
    await expectStatus(member.req("PUT", `/v1/meetings/${meetingId}`, { ...body(), rev: cur.rev }), 403);
    const moved = (await owner.req("PUT", `/v1/meetings/${meetingId}`, { ...body({ startsAt: at(120), endsAt: at(150) }), rev: cur.rev })).meeting;
    expect(moved.participants[0].response).toBe("pending");
    await expectStatus(owner.req("PUT", `/v1/meetings/${meetingId}`, { ...body(), rev: cur.rev }), 409);
  });

  it("'starting soon' goes out once, ten minutes ahead; cancelled meetings never", async () => {
    const soon = (await owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ startsAt: at(5), endsAt: at(35) }))).meeting.id;
    const cancelled = (await owner.req("POST", `/v1/orgs/${orgId}/meetings`, body({ startsAt: at(6), endsAt: at(36) }))).meeting.id;
    await owner.req("POST", `/v1/meetings/${cancelled}/cancel`);
    expect(await h.ctx.meetings.notifySoon()).toBe(1);
    expect(await h.ctx.meetings.notifySoon()).toBe(0);
    expect(h.ctx.ws.get<{ notified_at: number | null }>("meetings", { id: soon })!.notified_at).not.toBeNull();
    const features = (await owner.req("GET", "/v1/server-info")).features as string[];
    expect(features).toContain("meetings");
    // Removed with the community rebuild: older apps hide them when the server stops advertising them.
    for (const gone of ["groups", "workspace-templates", "integrations", "workflows", "documents", "developer-api", "ai", "unified-inbox"]) expect(features).not.toContain(gone);
  });
});
