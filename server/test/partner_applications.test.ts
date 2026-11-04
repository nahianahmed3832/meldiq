import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import { MemoryMailer } from "./support/accounts.js";
import { consoleAdmin } from "./support/adminConsole.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`private partner applications (${backend})`, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    beforeAll(async () => {
      h = await startServer(
        {
          ADMIN_CONSOLE_ORIGIN: "https://admin.example.test",
          MONGODB_DOMAINS:
            backend === "mongodb" ? "workspace,conversations,files,calls" : "",
        },
        { mailer },
      );
    });
    afterAll(async () => h?.close());
    it("keeps owner applications private, validates the checklist and records only explicit authorized reviews without a badge or role", async () => {
      const owner = await h.client("paowner"),
        member = await h.client("pamember");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Partner fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const path = `/v1/orgs/${org}/partner-application`;
      const body = {
        baseRev: 0,
        statement: "Private community application",
        checklist: {
          guidelines: true,
          moderation: true,
          safety: true,
          activity: true,
        },
      };
      expect((await owner.req("GET", path)).application).toBeNull();
      await expectStatus(member.req("GET", path), 404);
      await expectStatus(member.req("PUT", path, body), 404);
      await expectStatus(
        owner.req("PUT", path, {
          ...body,
          checklist: { ...body.checklist, safety: false },
        }),
        400,
      );
      const first = (await owner.req("PUT", path, body)).application;
      expect(first).toMatchObject({
        status: "submitted",
        rev: 1,
        reviewedAt: null,
      });
      await expectStatus(owner.req("PUT", path, body), 409);
      const support = await consoleAdmin(
          h,
          mailer,
          "support_admin",
          "pasupport",
        ),
        reviewer = await consoleAdmin(h, mailer, "super_admin", "pareviewer");
      await support.browser.expect(
        403,
        "GET",
        "/admin/v1/partner-applications",
      );
      const queue = await reviewer.browser.expect(
        200,
        "GET",
        "/admin/v1/partner-applications?limit=1",
      );
      expect(queue.applications[0]).toMatchObject({
        orgId: org,
        statement: body.statement,
      });
      expect(JSON.stringify(queue)).not.toContain(owner.userId);
      const reviewPath = `/admin/v1/partner-applications/${org}`;
      await support.browser.expect(403, "PUT", reviewPath, {
        baseRev: 1,
        status: "approved",
        reason: "Reviewed application checklist",
      });
      await reviewer.browser.expect(200, "PUT", reviewPath, {
        baseRev: 1,
        status: "declined",
        reason: "Please describe your moderation coverage",
      });
      expect((await owner.req("GET", path)).application).toMatchObject({
        status: "declined",
        rev: 2,
        reviewNote: "Please describe your moderation coverage",
      });
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/audit`)).entries.some(
          (e: any) => JSON.stringify(e).includes(body.statement),
        ),
      ).toBe(false);
      await owner.req("PUT", path, {
        ...body,
        baseRev: 2,
        statement: "Updated private application",
      });
      const before = h.ctx.ws.get("orgs", { id: org }),
        rolesBefore = h.ctx.ws.all("org_role_members", {
          where: { org_id: org },
        });
      const results = await Promise.allSettled(
        ["approved", "declined"].map((status) =>
          reviewer.browser.expect(200, "PUT", reviewPath, {
            baseRev: 3,
            status,
            reason: "Manual review of the updated application",
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(h.ctx.ws.get("orgs", { id: org })).toEqual(before);
      expect(
        h.ctx.ws.all("org_role_members", { where: { org_id: org } }),
      ).toEqual(rolesBefore);
      expect(
        h.ctx.platform.count("platform_audit", {
          action: "partner.review",
          target_id: org,
        }),
      ).toBe(2);
    });
  });
