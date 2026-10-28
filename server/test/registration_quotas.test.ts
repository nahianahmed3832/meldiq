import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistrationInvite } from "../src/modules/organizations/invites.js";
import { removeStalePartials } from "../src/modules/files/routes.js";
import { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

const MiB = 1024 * 1024;

describe("invite-only registration (T1.6)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ REGISTRATION_MODE: "invite" });
  });
  afterAll(async () => h.close());

  const fresh = (name: string) => new GriipClient(h.baseUrl, `${name}${crypto.randomBytes(3).toString("hex")}`, name);
  const users = () => h.ctx.identity.count("users");
  const invite = (maxUses = 1, days = 1) => createRegistrationInvite(h.ctx.identity, { maxUses, days, note: "test" });

  it("refuses registration without a code or with an unknown one, creating nothing", async () => {
    const before = users();
    expect((await expectStatus(fresh("nocode").register(), 403)).error.code).toBe("invite_required");
    expect((await expectStatus(fresh("badcode").register("ABCD-EFGH-JKMN"), 403)).error.code).toBe("invalid_invite");
    expect(users()).toBe(before);
  });

  it("a registration invite admits up to its use limit and stores only a hash of the code", async () => {
    const { id, code } = await invite(2);
    await fresh("first").register(code);
    await fresh("second").register(code.toLowerCase().replace(/-/g, " ")); // typed loosely
    expect((await expectStatus(fresh("third").register(code), 403)).error.code).toBe("invalid_invite");
    const row = h.ctx.identity.get<Record<string, unknown>>("registration_invites", { id })!;
    expect(row.uses).toBe(2);
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, ""));
  });

  it("expired and revoked registration invites are refused", async () => {
    const expired = await invite();
    await h.ctx.identity.write((w) => w.update("registration_invites", { id: expired.id }, { expires_at: Date.now() - 1 }));
    await expectStatus(fresh("late").register(expired.code), 403);
    const revoked = await invite();
    await h.ctx.identity.write((w) => w.update("registration_invites", { id: revoked.id }, { revoked_at: Date.now() }));
    await expectStatus(fresh("revoked").register(revoked.code), 403);
  });

  it("a community invite registers the person and joins them to its community and role in one step", async () => {
    const owner = await fresh("owner").register((await invite()).code);
    const org = (await owner.req("POST", "/v1/orgs", { name: "Gate Co" })).org.id;
    const role = (await owner.req("POST", `/v1/orgs/${org}/roles`, { name: "Sales", permissions: [], denies: [] })).role.id;
    const code = (await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER", roleId: role, maxUses: 1 })).invite.code;

    const newbie = await fresh("newbie").register(code);
    expect((await newbie.req("GET", "/v1/orgs")).orgs.map((o: any) => o.id)).toContain(org);
    expect((await owner.req("GET", `/v1/roles/${role}/members`)).members.map((m: any) => m.id)).toContain(newbie.userId);
    // The single use was consumed by the registration.
    await expectStatus(fresh("second").register(code), 403);
  });

  it("existing accounts keep signing in normally", async () => {
    const c = await fresh("returning").register((await invite()).code);
    c.token = "";
    await c.login();
    expect(c.token.length).toBeGreaterThan(20);
    expect((await c.req("GET", "/v1/conversations")).conversations).toEqual([]);
  });

  it("no HTTP route mints registration invites", () => {
    expect(h.app.printRoutes()).not.toMatch(/registration/i);
  });
});

describe("upload limits (T1.6)", () => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, dave: GriipClient;
  let dm: string, dm2: string;

  beforeAll(async () => {
    h = await startServer({
      ATTACHMENT_MAX_BYTES: String(1 * MiB),
      ATTACHMENT_USER_DAILY_BYTES: String(3 * MiB),
      ATTACHMENT_USER_STORED_BYTES: String(10 * MiB),
      ATTACHMENT_TOTAL_BYTES: String(5 * MiB),
      ATTACHMENT_MAX_CONCURRENT_PER_USER: "1",
      ATTACHMENT_MAX_CONCURRENT: "4",
      ATTACHMENT_MAX_PENDING_BYTES: String(8 * MiB),
    });
    alice = await h.client("alice");
    bob = await h.client("bob");
    dave = await h.client("dave");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    dm2 = (await dave.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  });
  afterAll(async () => h.close());

  /** A raw streaming upload with chunked transfer encoding (no content-length), for size and concurrency tests. */
  const stream = (who: GriipClient, convId: string) => {
    const req = http.request(new URL(`/v1/attachments?conversationId=${convId}`, h.baseUrl), {
      method: "POST",
      agent: false, // a fresh connection: a refused upload can leave its kept-alive socket closed
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
    });
    const done = new Promise<{ status: number; body: any }>((resolve) => {
      req.on("response", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: d ? JSON.parse(d) : null }));
      });
      req.on("error", () => resolve({ status: 0, body: null })); // server closed after refusing
    });
    return { req, done };
  };
  const partials = () => fs.readdirSync(h.ctx.config.attachmentDir).filter((f) => f.endsWith(".part"));
  const blob = (n: number) => crypto.randomBytes(n);

  it("streams an upload of unknown length to disk and serves it back intact", async () => {
    const up = stream(alice, dm);
    const parts = [blob(200_000), blob(200_000), blob(200_000)];
    for (const p of parts) up.req.write(p);
    up.req.end();
    const r = await up.done;
    expect(r.status).toBe(200);
    expect(r.body.size).toBe(600_000);
    const down: Buffer = await bob.req("GET", `/v1/attachments/${r.body.id}`);
    expect(crypto.createHash("sha256").update(down).digest("hex")).toBe(crypto.createHash("sha256").update(Buffer.concat(parts)).digest("hex"));
  });

  it("refuses a body over the size limit, declared or streamed, and leaves no partial file", async () => {
    expect((await expectStatus(alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB + 1)), 413)).error.code).toBe("too_large");
    const up = stream(alice, dm);
    for (let i = 0; i < 6; i++) up.req.write(blob(200_000)); // 1.2 MB, past the 1 MiB limit mid-stream
    up.req.end();
    const r = await up.done;
    expect([413, 0]).toContain(r.status);
    await new Promise((res) => setTimeout(res, 50));
    expect(partials()).toEqual([]);
  });

  it("limits concurrent uploads per user", async () => {
    const slow = stream(dave, dm2);
    slow.req.write(blob(1000));
    await dave.waitFor(() => partials().length > 0); // its .part file exists once the server has counted it in flight
    const second = await expectStatus(dave.req("POST", `/v1/attachments?conversationId=${dm2}`, undefined, blob(1000)), 429);
    expect(second.error.code).toBe("too_many_uploads");
    slow.req.end(blob(1000));
    expect((await slow.done).status).toBe(200);
    // With the first finished, a new upload goes through.
    await dave.req("POST", `/v1/attachments?conversationId=${dm2}`, undefined, blob(1000));
  });

  it("enforces the per-user daily quota", async () => {
    // alice has 600 kB today; two 1 MiB uploads fit in 3 MiB, a third doesn't.
    await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB));
    await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB));
    const e = await expectStatus(alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB)), 429);
    expect(e.error.code).toBe("quota_exceeded");
  });

  it("enforces the server-wide storage cap", async () => {
    // About 2.6 MiB is stored. Bob's first two 1 MiB uploads fit under 5 MiB, the third doesn't.
    await bob.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB));
    await bob.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB));
    const e = await expectStatus(bob.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob(MiB)), 507);
    expect(e.error.code).toBe("storage_full");
  });

  it("removes partial files left by uploads interrupted by a restart", () => {
    const dir = h.ctx.config.attachmentDir;
    fs.writeFileSync(path.join(dir, "a_interrupted.part"), "x");
    const kept = fs.readdirSync(dir).filter((f) => !f.endsWith(".part"));
    expect(removeStalePartials(dir)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(kept.sort());
  });
});

describe("resumable downloads (T2.6)", () => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, eve: GriipClient;
  let id: string;
  const blob = crypto.randomBytes(300_000);
  const get = (who: GriipClient, range?: string) =>
    fetch(`${h.baseUrl}/v1/attachments/${id}`, { headers: { authorization: `Bearer ${who.token}`, ...(range ? { range } : {}) } });

  beforeAll(async () => {
    h = await startServer();
    alice = await h.client("rngalice");
    bob = await h.client("rngbob");
    eve = await h.client("rngeve");
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    id = (await alice.req("POST", `/v1/attachments?conversationId=${dm}`, undefined, blob)).id;
  });
  afterAll(async () => h.close());

  it("serves the rest of a file from an offset, so an interrupted download resumes", async () => {
    const r = await get(bob, "bytes=100000-");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 100000-299999/300000`);
    const tail = Buffer.from(await r.arrayBuffer());
    expect(Buffer.concat([blob.subarray(0, 100000), tail]).equals(blob)).toBe(true);
    const mid = await get(bob, "bytes=10-19");
    expect(Buffer.from(await mid.arrayBuffer()).equals(blob.subarray(10, 20))).toBe(true);
  });

  it("still checks membership, and rejects a range past the end", async () => {
    expect((await get(eve, "bytes=0-")).status).toBe(404);
    const r = await get(bob, "bytes=300000-");
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */300000");
    expect((await get(bob)).status).toBe(200);
  });
});
