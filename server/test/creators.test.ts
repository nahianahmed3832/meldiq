import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalHolds, normalizedName, sameName } from "../src/modules/accounts/creators/rules.js";
import {
  AdminCreatorPostReviewed,
  AdminCreatorPostsPage,
  AdminCreatorProgramDecided,
  AdminCreatorProgramPage,
  AdminCreatorVerificationDecided,
  AdminCreatorVerificationPage,
  CreatorProgramView,
  CreatorVerificationView,
} from "../src/shared/contracts/http/creators.js";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { ADMIN_ORIGIN, type ConsoleAdmin, consoleAdmin } from "./support/adminConsole.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** API 0.65.0 batch B (docs/SETTINGS_PARITY_API.md): creator verification, the Creator badge and the creator programme. */

/** A PNG's chunk structure (IHDR, IDAT, IEND): what the parser reads. */
function png(w = 640, h = 360): Buffer {
  const chunk = (id: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(id, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(16)), chunk("IEND", Buffer.alloc(0))]);
}

describe("the name rule", () => {
  it("ignores case, spaces, underscores, dots and a leading @", () => {
    expect(normalizedName(" @Ada_Plays.Games ")).toBe("adaplaysgames");
    expect(sameName("Ada Plays Games", "ada_plays.games")).toBe(true);
    expect(sameName("Ada Plays", "ada_plays_games")).toBe(false);
    expect(sameName("...", "")).toBe(false);
  });

  it("keeps an approval while the username is the approved one or still matches", () => {
    const a = { channelName: "Cat Videos", usernameAtApproval: "kitty" };
    expect(approvalHolds(a, "kitty")).toBe(true);
    expect(approvalHolds(a, "cat_videos")).toBe(true);
    expect(approvalHolds(a, "dog_videos")).toBe(false);
    expect(approvalHolds(a, null)).toBe(false);
  });
});

/** Production's MongoDB domains: the new data then lives in MongoDB (new data goes there whenever the server has one). */
const PRODUCTION_DOMAINS = "preferences,reports,relationships,history,accounts,files,relay,billing";

describe.each([
  ["memory", {}],
  ["mongodb", { MONGODB_DOMAINS: PRODUCTION_DOMAINS }],
] as const)("creators, kept in %s", (backend, env) => {
  let h: Harness;
  const mailer = new MemoryMailer();
  let support: ConsoleAdmin, billing: ConsoleAdmin;
  let ada: GriipClient, bob: GriipClient, cat: GriipClient;
  const REASON = "The follower count isn't visible in the screenshot";

  const apply = (c: GriipClient, form: Record<string, string>, image: Buffer = png()) => c.req("POST", `/v2/creators/verification?${new URLSearchParams(form).toString()}`, undefined, image);
  const form = (channelName: string, extra: Record<string, string> = {}) => ({
    platform: "youtube",
    channelName,
    link: "https://youtube.com/@channel",
    bioLineConfirmed: "true",
    ...extra,
  });
  const pending = async () => (await support.browser.expect(200, "GET", "/admin/v1/creators/verification")).applications as { id: string; user: { userId: string } }[];
  const pendingOf = async (c: GriipClient) => (await pending()).find((a) => a.user.userId === c.userId)!;
  const rename = async (c: GriipClient, username: string) => {
    // The hourly limit on username changes has its own suite.
    await h.ctx.identity.write((w) => w.update("users", { id: c.userId }, { username_changed_at: null }));
    await c.req("PATCH", "/v1/users/me", { username });
  };

  beforeAll(async () => {
    h = await startServer({ ADMIN_CONSOLE_ORIGIN: ADMIN_ORIGIN, ...env }, { mailer });
    expect(h.ctx.creators.stores.verifications.backend).toBe(backend);
    [ada, bob, cat] = await Promise.all([h.client(`ada${backend}`), h.client(`bob${backend}`), h.client(`cat${backend}`, "Cat Videos")]);
    support = await consoleAdmin(h, mailer, "support_admin", `crsupport${backend}`);
    billing = await consoleAdmin(h, mailer, "billing_admin", `crbilling${backend}`);
  });
  afterAll(async () => h.close());

  it("is advertised in the server's features", async () => {
    const { features } = await ada.req("GET", "/v1/server-info");
    expect(features).toEqual(expect.arrayContaining(["creator-verification", "creator-program", "connections-v2"]));
  });

  describe("applying", () => {
    it("takes one open application at a time; the name may match the display name instead", async () => {
      const { application } = await apply(ada, form(`@${ada.username.toUpperCase()}`, { notes: "Gaming videos, 12k followers" }));
      expect(application).toMatchObject({ status: "pending", platform: "youtube", notes: "Gaming videos, 12k followers", reason: null, reviewedAt: null });
      expect((await expectStatus(apply(ada, form(ada.username)), 409)).error.code).toBe("application_open");
      expect((await apply(cat, form("cat_videos", { platform: "tiktok", link: "https://tiktok.com/@catvideos" }))).application.status).toBe("pending");
    });

    it("shows the code line, the rules and the applications", async () => {
      const v = await ada.req("GET", "/v2/creators/verification");
      expect(CreatorVerificationView.safeParse(v).success).toBe(true);
      expect(v).toMatchObject({ codeLine: `meldiq: ${ada.username}`, verified: false, applications: [{ status: "pending", channelName: `@${ada.username.toUpperCase()}` }] });
      expect(v.rules).toMatchObject({ minFollowers: 1000, notesMax: 500, proofMaxBytes: 4 * 1024 * 1024, platforms: ["youtube", "tiktok", "twitch", "instagram", "x"] });
    });

    it("checks the form, the name and the proof", async () => {
      await expectStatus(apply(bob, form(bob.username, { platform: "myspace" })), 400);
      await expectStatus(apply(bob, form(bob.username, { link: "http://youtube.com/@ada" })), 400);
      await expectStatus(apply(bob, { ...form(bob.username), bioLineConfirmed: "false" }), 400);
      await expectStatus(apply(bob, form(bob.username, { notes: "x".repeat(501) })), 400);
      await expectStatus(apply(bob, form(bob.username), Buffer.from("not an image")), 400);
      const tooBig = Buffer.concat([png(), Buffer.alloc(4 * 1024 * 1024)]);
      expect((await expectStatus(apply(bob, form(bob.username), tooBig), 413)).error.code).toBe("too_large");
      expect((await expectStatus(apply(bob, form("Someone Else")), 400)).error.code).toBe("creator_name_mismatch");
      expect((await bob.req("GET", "/v2/creators/verification")).applications).toEqual([]);
    });
  });

  describe("review in the admin console", () => {
    it("is for support and operations admins, not billing admins, and shows the proof in a sandbox", async () => {
      await billing.browser.expect(403, "GET", "/admin/v1/creators/verification");
      const page = await support.browser.expect(200, "GET", "/admin/v1/creators/verification");
      expect(AdminCreatorVerificationPage.safeParse(page).success).toBe(true);
      const mine = page.applications.find((a: { user: { userId: string } }) => a.user.userId === ada.userId);
      expect(mine).toMatchObject({ codeLine: `meldiq: ${ada.username}`, nameMatches: true, proofType: "image/png", user: { username: ada.username } });
      const proof = await support.browser.req("GET", mine.proofUrl);
      expect(proof.status).toBe(200);
      expect(proof.headers["content-type"]).toBe("image/png");
      expect(proof.headers["content-security-policy"]).toContain("sandbox");
      expect(proof.headers["cache-control"]).toBe("no-store");
    });

    it("turns one down with a reason the applicant sees; they can apply again", async () => {
      const id = (await pendingOf(ada)).id;
      await support.browser.expect(400, "POST", `/admin/v1/creators/verification/${id}/reject`, { reason: "no" });
      const decided = await support.browser.expect(200, "POST", `/admin/v1/creators/verification/${id}/reject`, { reason: REASON });
      expect(AdminCreatorVerificationDecided.safeParse(decided).success).toBe(true);
      await support.browser.expect(409, "POST", `/admin/v1/creators/verification/${id}/approve`);
      const v = await ada.req("GET", "/v2/creators/verification");
      expect(v.verified).toBe(false);
      expect(v.applications[0]).toMatchObject({ id, status: "rejected", reason: REASON });
      expect(h.ctx.platform.get<any>("platform_audit", { action: "creator.verification.reject" }, [["id", "desc"]])).toMatchObject({ target_id: id, actor_role: "support_admin" });
      expect((await apply(ada, form(ada.username))).application.status).toBe("pending");
    });

    it("approves one: the Creator badge, which can be shown by the name", async () => {
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "creator" }), 400);
      const id = (await pendingOf(ada)).id;
      expect((await support.browser.expect(200, "POST", `/admin/v1/creators/verification/${id}/approve`)).application.status).toBe("approved");
      expect((await ada.req("GET", "/v2/creators/verification")).verified).toBe(true);
      expect((await ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "creator" })).profileStyle.shownBadge).toBe("creator");
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle.shownBadge).toBe("creator");
      expect(h.ctx.platform.get<any>("platform_audit", { action: "creator.verification.approve" }, [["id", "desc"]])).toMatchObject({ target_id: id });
    });

    it("keeps the badge through display name changes, and loses it with a username that no longer matches", async () => {
      await ada.req("PATCH", "/v1/users/me", { displayName: "Someone New" });
      expect((await ada.req("GET", "/v2/creators/verification")).verified).toBe(true);
      const original = ada.username;
      await rename(ada, `${original}_x`);
      expect((await ada.req("GET", "/v2/creators/verification")).verified).toBe(false);
      expect((await bob.req("GET", `/v1/users/${ada.userId}`)).user.profileStyle?.shownBadge ?? null).toBeNull();
      await expectStatus(ada.req("PUT", "/v1/users/me/profile-style", { shownBadge: "creator" }), 400);
      // "_" and "." don't count, so this one matches the channel again.
      await rename(ada, `${original.slice(0, 1)}_${original.slice(1)}`);
      expect((await ada.req("GET", "/v2/creators/verification")).verified).toBe(true);
    });

    it("lets a channel approved by its display name survive a display name change", async () => {
      await support.browser.expect(200, "POST", `/admin/v1/creators/verification/${(await pendingOf(cat)).id}/approve`);
      expect((await cat.req("GET", "/v2/creators/verification")).verified).toBe(true);
      await cat.req("PATCH", "/v1/users/me", { displayName: "Cat" });
      expect((await cat.req("GET", "/v2/creators/verification")).verified).toBe(true);
    });
  });

  describe("the creator programme", () => {
    it("takes an application from a verified creator, once at a time, and an operator approves it", async () => {
      const { application } = await ada.req("POST", "/v2/creators/program/apply");
      expect(application.status).toBe("pending");
      expect((await expectStatus(ada.req("POST", "/v2/creators/program/apply"), 409)).error.code).toBe("application_open");
      expect((await expectStatus(ada.req("POST", "/v2/creators/posts", { url: "https://youtube.com/watch?v=1", platform: "youtube" }), 403)).error.code).toBe("not_in_creator_program");
      expect((await ada.req("GET", "/v2/creators/program")).steps).toEqual({ verified: true, applied: true, approved: false });

      await billing.browser.expect(403, "GET", "/admin/v1/creators/program");
      const page = await support.browser.expect(200, "GET", "/admin/v1/creators/program");
      expect(AdminCreatorProgramPage.safeParse(page).success).toBe(true);
      expect(page.applications.find((a: { id: string }) => a.id === application.id)).toMatchObject({ verified: true, user: { userId: ada.userId } });
      const decided = await support.browser.expect(200, "POST", `/admin/v1/creators/program/${application.id}/approve`);
      expect(AdminCreatorProgramDecided.safeParse(decided).success).toBe(true);
      expect((await ada.req("GET", "/v2/creators/program")).steps).toEqual({ verified: true, applied: true, approved: true });
      expect((await expectStatus(ada.req("POST", "/v2/creators/program/apply"), 409)).error.code).toBe("conflict");
    });

    it("shows a programme rejection's reason", async () => {
      const { application } = await cat.req("POST", "/v2/creators/program/apply");
      await support.browser.expect(200, "POST", `/admin/v1/creators/program/${application.id}/reject`, { reason: REASON });
      expect((await cat.req("GET", "/v2/creators/program")).application).toMatchObject({ status: "rejected", reason: REASON });
    });

    it("takes posts from members, once per link; operators count them and note a reward", async () => {
      await expectStatus(ada.req("POST", "/v2/creators/posts", { url: "ftp://example.com/x", platform: "youtube" }), 400);
      const { post } = await ada.req("POST", "/v2/creators/posts", { url: "https://youtube.com/watch?v=meldiq1", platform: "youtube", views: 4200 });
      expect(post).toMatchObject({ views: 4200, counted: false, rewardNote: null });
      expect((await expectStatus(ada.req("POST", "/v2/creators/posts", { url: "https://youtube.com/watch?v=meldiq1", platform: "youtube" }), 409)).error.code).toBe("conflict");

      const page = await support.browser.expect(200, "GET", "/admin/v1/creators/posts");
      expect(AdminCreatorPostsPage.safeParse(page).success).toBe(true);
      expect(page.posts.map((p: { id: string }) => p.id)).toContain(post.id);
      const reviewed = await support.browser.expect(200, "POST", `/admin/v1/creators/posts/${post.id}/review`, { counted: true, rewardNote: "One month of Mojo Go" });
      expect(AdminCreatorPostReviewed.safeParse(reviewed).success).toBe(true);
      expect((await support.browser.expect(200, "GET", "/admin/v1/creators/posts?status=counted")).posts.map((p: { id: string }) => p.id)).toContain(post.id);

      const mine = await ada.req("GET", "/v2/creators/posts");
      expect(mine.posts[0]).toMatchObject({ id: post.id, counted: true, rewardNote: "One month of Mojo Go" });
      expect((await ada.req("GET", "/v2/creators/program")).posts[0].counted).toBe(true);
    });

    it("needs a verified channel first", async () => {
      const steps = await bob.req("GET", "/v2/creators/program");
      expect(CreatorProgramView.safeParse(steps).success).toBe(true);
      expect(steps).toMatchObject({ steps: { verified: false, applied: false, approved: false }, application: null, posts: [] });
      expect((await expectStatus(bob.req("POST", "/v2/creators/program/apply"), 403)).error.code).toBe("not_verified_creator");
      expect((await expectStatus(bob.req("POST", "/v2/creators/posts", { url: "https://youtube.com/watch?v=1", platform: "youtube" }), 403)).error.code).toBe("not_in_creator_program");
    });

    it("stops taking posts once the badge is lost", async () => {
      const current = (await ada.req("GET", "/v1/users/me")).user.username;
      await rename(ada, `${current}zz`);
      expect((await expectStatus(ada.req("POST", "/v2/creators/posts", { url: "https://youtube.com/watch?v=meldiq2", platform: "youtube" }), 403)).error.code).toBe("not_in_creator_program");
      await rename(ada, current);
    });
  });

  it("forgets applications, proofs, programme applications and posts when the account is deleted", async () => {
    const dee = await AccountClient.ready(h.baseUrl, mailer, `dee${backend}`);
    const { application } = await dee.req("POST", `/v2/creators/verification?${new URLSearchParams(form(dee.username)).toString()}`, undefined, png());
    await support.browser.expect(200, "POST", `/admin/v1/creators/verification/${application.id}/approve`);
    const program = await dee.req("POST", "/v2/creators/program/apply");
    await support.browser.expect(200, "POST", `/admin/v1/creators/program/${program.application.id}/approve`);
    await dee.req("POST", "/v2/creators/posts", { url: "https://youtube.com/watch?v=dee", platform: "youtube" });
    const stored = await h.ctx.blobs.get("profile-photos", `creator-proof-${application.id}`);
    expect(stored).not.toBeNull();
    stored?.destroy();

    await dee.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: dee.email });
    const s = h.ctx.creators.stores;
    expect(await s.verifications.count({ userId: dee.userId })).toBe(0);
    expect(await s.program.count({ userId: dee.userId })).toBe(0);
    expect(await s.posts.count({ userId: dee.userId })).toBe(0);
    expect(await h.ctx.blobs.get("profile-photos", `creator-proof-${application.id}`)).toBeNull();
    expect(h.ctx.creators.isVerified(dee.userId)).toBe(false);
  });
});
