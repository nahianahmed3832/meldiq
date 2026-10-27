import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** Batch B4b: join applications, activity alerts on join spikes, and the public invite preview. */
let h: Harness;
let owner: GriipClient, mod: GriipClient, member: GriipClient, applicant: GriipClient, other: GriipClient, banned: GriipClient;
let orgId: string, privateOrg: string;

beforeAll(async () => {
  h = await startServer();
  [owner, mod, member, applicant, other, banned] = await Promise.all(["owner", "mod", "member", "applicant", "other", "banned"].map((n) => h.client(n)));
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Apply Lab", visibility: "public", joinPolicy: "invite" })).org.id;
  privateOrg = (await owner.req("POST", "/v1/orgs", { name: "Quiet Lab" })).org.id;
  const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER", maxUses: 5 })).invite.code;
  for (const c of [mod, member, banned]) await c.req("POST", "/v1/invites/accept", { code });
  const role = (await owner.req("POST", `/v1/orgs/${orgId}/roles`, { template: "moderator" })).role;
  await owner.req("PUT", `/v1/roles/${role.id}/members/${mod.userId}`);
  await owner.req("POST", `/v1/orgs/${orgId}/bans`, { userId: banned.userId }).catch(async () => owner.req("PUT", `/v1/orgs/${orgId}/bans/${banned.userId}`, {}));
});
afterAll(async () => h.close());

describe("join applications", () => {
  it("advertises the features", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toEqual(expect.arrayContaining(["join-applications", "activity-alerts", "invite-links"]));
  });

  it("are turned on by people who edit the community, with up to five questions", async () => {
    await expectStatus(member.req("PUT", `/v1/orgs/${orgId}/application`, { questions: ["Why?"] }), 403);
    await expectStatus(owner.req("PUT", `/v1/orgs/${orgId}/application`, { questions: ["1", "2", "3", "4", "5", "6"] }), 400);
    expect((await owner.req("PUT", `/v1/orgs/${orgId}/application`, { questions: ["Why do you want to join?", "How did you find us?"] })).questions).toHaveLength(2);
    const preview = await applicant.req("GET", `/v1/communities/${orgId}/preview`);
    expect(preview.community.joinQuestions).toEqual(["Why do you want to join?", "How did you find us?"]);
    expect(preview.application).toBeNull();
    expect((await applicant.req("GET", "/v1/communities/discover")).communities.find((c: { id: string }) => c.id === orgId).applications).toBe(true);
  });

  it("need every answer, once; banned people and private communities can't apply", async () => {
    await expectStatus(applicant.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["only one"] }), 400);
    const first = await applicant.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["I like labs", "A friend"] });
    expect(first).toMatchObject({ repeated: false, application: { status: "pending", answers: ["I like labs", "A friend"] } });
    expect((await applicant.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["again", "again"] })).repeated).toBe(true);
    await expectStatus(member.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["a", "b"] }), 409);
    await expectStatus(banned.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["a", "b"] }), 403);
    await expectStatus(applicant.req("POST", `/v1/communities/${privateOrg}/apply`, { answers: ["a"] }), 404);
    expect((await applicant.req("GET", `/v1/communities/${orgId}/preview`)).application.status).toBe("pending");
  });

  it("are listed for people with members.approve, who approve (the person joins) or deny", async () => {
    await expectStatus(member.req("GET", `/v1/orgs/${orgId}/applications`), 403);
    const q = await mod.req("GET", `/v1/orgs/${orgId}/applications`);
    expect(q.pending).toBe(1);
    expect(q.applications[0]).toMatchObject({ user: { id: applicant.userId }, questions: ["Why do you want to join?", "How did you find us?"], answers: ["I like labs", "A friend"] });
    const done = await mod.req("PATCH", `/v1/applications/${q.applications[0].id}`, { status: "approved", note: "welcome" });
    expect(done.application).toMatchObject({ status: "approved", handledByName: expect.any(String), note: "welcome" });
    expect((await applicant.req("GET", "/v1/orgs")).orgs.map((o: { id: string }) => o.id)).toContain(orgId);
    await expectStatus(mod.req("PATCH", `/v1/applications/${q.applications[0].id}`, { status: "denied" }), 409);
    const d = await other.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["x", "y"] });
    await mod.req("PATCH", `/v1/applications/${d.application.id}`, { status: "denied" });
    expect((await other.req("GET", "/v1/me/applications")).applications[0]).toMatchObject({ orgId, orgName: "Apply Lab", status: "denied" });
    const audit = (await owner.req("GET", `/v1/orgs/${orgId}/audit?action=application`)).entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["application.approved", "application.denied"]));
  });

  it("replace open joining while the questions are on", async () => {
    const open = (await owner.req("POST", "/v1/orgs", { name: "Open Lab", visibility: "public", joinPolicy: "open" })).org.id;
    await owner.req("PUT", `/v1/orgs/${open}/application`, { questions: ["Hello?"] });
    expect((await expectStatus(other.req("POST", `/v1/communities/${open}/join`), 403)).error.code).toBe("application_required");
    await owner.req("PUT", `/v1/orgs/${open}/application`, { questions: null });
    expect((await other.req("POST", `/v1/communities/${open}/join`)).alreadyMember).toBe(false);
  });

  it("can be withdrawn, and are refused while joining is paused", async () => {
    const again = await other.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["x", "y"] });
    await other.req("DELETE", `/v1/applications/${again.application.id}`);
    expect((await other.req("GET", "/v1/me/applications")).applications[0].status).toBe("withdrawn");
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: Date.now() + 3_600_000 });
    expect((await expectStatus(other.req("POST", `/v1/communities/${orgId}/apply`, { answers: ["x", "y"] }), 403)).error.code).toBe("invites_paused");
    await owner.req("PUT", `/v1/orgs/${orgId}/security`, { invitesPausedUntil: null });
  });
});

describe("activity alerts", () => {
  it("tell moderators when ten or more people join within ten minutes, once per half hour, and can be turned off", async () => {
    const open = (await owner.req("POST", "/v1/orgs", { name: "Busy Lab", visibility: "public", joinPolicy: "open" })).org.id;
    // The owner joined when creating it: with 8 more that's 9 joins, and the 10th sets the alert off.
    const joiners = await Promise.all(Array.from({ length: 9 }, (_, i) => h.client(`joiner${i}`)));
    for (const j of joiners.slice(0, 8)) await j.req("POST", `/v1/communities/${open}/join`);
    expect((await owner.req("GET", `/v1/orgs/${open}`)).org.activityAlert).toBeNull();
    await joiners[8].req("POST", `/v1/communities/${open}/join`);
    const alert = (await owner.req("GET", `/v1/orgs/${open}`)).org.activityAlert;
    expect(alert).toMatchObject({ kind: "joins", count: 10 });
    // Ordinary members don't see it.
    expect((await joiners[0].req("GET", `/v1/orgs/${open}`)).org.activityAlert).toBeNull();
    expect((await owner.req("GET", `/v1/orgs/${open}/audit?action=community.activity_alert`)).entries).toHaveLength(1);
    await owner.req("PUT", `/v1/orgs/${open}/security`, { activityAlerts: false });
    expect((await owner.req("GET", `/v1/orgs/${open}`)).org.activityAlerts).toBe(false);
  });
});

describe("public invite preview", () => {
  it("shows the community's name and size without signing in, and the usual problems", async () => {
    const code = (await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })).invite.code;
    const r = await fetch(`${h.baseUrl}/v1/invites/${code}/public`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ community: { name: "Apply Lab", description: null, memberCount: expect.any(Number), accent: null, banner: false, photo: false }, invitesPaused: false });
    const bad = await fetch(`${h.baseUrl}/v1/invites/AAAA-BBBB-CCCC/public`);
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe("invite_not_found");
  });
});
