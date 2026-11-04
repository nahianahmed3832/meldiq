import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import { MemoryMailer } from "./support/accounts.js";
import { AdminBrowser, consoleAdmin } from "./support/adminConsole.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`private community reports (${backend})`, () => {
    let h: Harness;
    const mailer = new MemoryMailer();
    beforeAll(async () => {
      h = await startServer(
        {
          ADMIN_CONSOLE_ORIGIN: "https://admin.example.test",
          MONGODB_DOMAINS: backend === "mongodb" ? "reports" : "",
        },
        { mailer },
      );
    });
    afterAll(async () => h?.close());
    it("routes only to operators, deduplicates concurrent retries, preserves privacy and never applies a sanction", async () => {
      const owner = await h.client("cr_owner"),
        member = await h.client("cr_member"),
        outsider = await h.client("cr_outsider");
      const org = (
        await owner.req("POST", "/v1/orgs", {
          name: "Community report fixture",
        })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const path = `/v1/orgs/${org}/report`,
        note = "Private community safety evidence";
      await expectStatus(
        outsider.req("POST", path, { reason: "spam", note }),
        404,
      );
      await expectStatus(
        member.req("POST", path, {
          reason: "spam",
          targetUserId: owner.userId,
        }),
        400,
      );
      const submitted = await Promise.all(
        Array.from({ length: 3 }, () =>
          member.req("POST", path, { reason: "spam", note }),
        ),
      );
      expect(new Set(submitted.map((s) => s.report.id)).size).toBe(1);
      expect(submitted.filter((s) => !s.report.repeated)).toHaveLength(1);
      expect(submitted.every((s) => s.report.to === "meldiq")).toBe(true);
      const id = submitted[0].report.id;
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/reports`)).reports,
      ).toEqual([]);
      await expectStatus(
        owner.req("PATCH", `/v1/reports/${id}`, { status: "dismissed" }),
        404,
      );
      // Ordinary app requests also lack the console's required origin and receive its hidden-route response.
      await expectStatus(member.req("GET", `/admin/v1/reports/${id}`), 404);
      await new AdminBrowser(h).expect(401, "GET", `/admin/v1/reports/${id}`);
      const operator = await consoleAdmin(
        h,
        mailer,
        "platform_moderator",
        "crmoderator",
      );
      const detail = await operator.browser.expect(
        200,
        "GET",
        `/admin/v1/reports/${id}`,
      );
      expect(detail.report).toMatchObject({
        kind: "community",
        targetCommunityId: org,
        targetUserId: null,
        communityNote: note,
      });
      expect(JSON.stringify(detail)).not.toContain(member.userId);
      expect(
        (await h.ctx.reports.adminList({ limit: 50 })).filter(
          (r) => r.target_org_id === org,
        ),
      ).toHaveLength(1);
      await operator.browser.expect(200, "PATCH", `/admin/v1/reports/${id}`, {
        version: 0,
        status: "dismissed",
        reason: "Reviewed the submitted community evidence",
      });
      const again = await member.req("POST", path, {
        reason: "spam",
        note: "Changed text cannot overwrite the report",
      });
      expect(again.report).toMatchObject({
        id,
        repeated: true,
        status: "dismissed",
      });
      expect((await h.ctx.reports.get(id))?.note).toBe(note);
      expect((await member.req("GET", `/v1/orgs/${org}`)).org.id).toBe(org);
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/audit`)).entries.some(
          (e: any) => JSON.stringify(e).includes(note),
        ),
      ).toBe(false);
    });
  });
