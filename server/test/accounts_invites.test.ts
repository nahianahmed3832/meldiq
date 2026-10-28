import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistrationInvite } from "../src/modules/organizations/invites.js";
import { AccountClient, email, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Invite-only servers (REGISTRATION_MODE=invite, the deployment default): an Orbit 2.0 sign-up uses up its invitation.
let h: Harness;
const mailer = new MemoryMailer();
beforeAll(async () => {
  h = await startServer({ REGISTRATION_MODE: "invite" }, { mailer });
});
afterAll(async () => h.close());

async function signUpWith(code: string | undefined, name: string): Promise<AccountClient> {
  const c = new AccountClient(h.baseUrl, email(name), PASSWORD, name);
  await c.req("POST", "/v2/auth/register", { name, email: c.email, password: PASSWORD, ...(code ? { inviteCode: code } : {}) });
  await c.req("POST", "/v2/auth/email/verify", { email: c.email, code: mailer.verifyCode(c.email), password: PASSWORD });
  return c;
}

describe("Orbit 2.0 sign-up on an invite-only server", () => {
  it("needs an invitation and uses one up per account", async () => {
    const probe = new AccountClient(h.baseUrl, email("none"));
    expect((await expectStatus(probe.req("POST", "/v2/auth/register", { name: "N", email: probe.email, password: PASSWORD }), 403)).error.code).toBe("invite_required");
    const invite = createRegistrationInvite(h.ctx.db, { maxUses: 1, days: 1 });
    const first = await signUpWith(invite.code, "firstuse");
    await first.signIn();
    // The same address signing up again doesn't take another use…
    await first.req("POST", "/v2/auth/register", { name: "Again", email: first.email, password: PASSWORD, inviteCode: invite.code }).catch(() => undefined);
    // …and the single use is gone for anyone else.
    const second = new AccountClient(h.baseUrl, email("seconduse"));
    const refused = await expectStatus(second.req("POST", "/v2/auth/register", { name: "S", email: second.email, password: PASSWORD, inviteCode: invite.code }), 403);
    expect(refused.error.code).toBe("invalid_invite");
    expect(h.ctx.db.prepare("SELECT uses FROM registration_invites WHERE id = ?").get(invite.id)).toEqual({ uses: 1 });
  });

  it("joins the organisation of an organisation invite once the encryption identity is made, using one use", async () => {
    const owner = await signUpWith(createRegistrationInvite(h.ctx.db, { maxUses: 1, days: 1 }).code, "orgowner");
    await owner.signIn();
    await owner.setUpIdentity();
    const org = (await owner.req("POST", "/v1/orgs", { name: `Invited ${Date.now()}` })).org;
    const invite = (await owner.req("POST", `/v1/orgs/${org.id}/invites`, { role: "MEMBER", maxUses: 1 })).invite;
    const member = await signUpWith(invite.code, "orgmember");
    expect(h.ctx.ws.get<{ uses: number }>("invitations", { id: invite.id })?.uses).toBe(1);
    // Reserved for this account: nobody else can sign up with it meanwhile.
    const other = new AccountClient(h.baseUrl, email("orgother"));
    await expectStatus(other.req("POST", "/v2/auth/register", { name: "O", email: other.email, password: PASSWORD, inviteCode: invite.code }), 403);
    await member.signIn();
    await member.setUpIdentity();
    const ws = await member.req("GET", "/v2/workspaces");
    expect(ws.workspaces.find((w: any) => w.id === org.id)?.role).toBe("MEMBER");
    expect(h.ctx.ws.get<{ uses: number }>("invitations", { id: invite.id })?.uses).toBe(1);
  });
});
