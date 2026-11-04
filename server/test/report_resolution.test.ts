import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`report resolution (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS: backend === "mongodb" ? "reports" : "",
      });
    });
    afterAll(async () => h?.close());
    it("applies concurrent retries once, preserves the first handler/time, audits real changes and never sanctions", async () => {
      const owner = await h.client("resowner"),
        reporter = await h.client("resreporter"),
        target = await h.client("restarget");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Resolution fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, {
          role: "MEMBER",
          maxUses: 2,
        })
      ).invite.code;
      for (const c of [reporter, target])
        await c.req("POST", "/v1/invites/accept", { code });
      const id = (
        await reporter.req("POST", "/v1/reports", {
          targetUserId: target.userId,
          orgId: org,
          reason: "spam",
        })
      ).report.id;
      const path = `/v1/reports/${id}`;
      await expectStatus(
        reporter.req("PATCH", path, { status: "actioned" }),
        404,
      );
      const before = h.ctx.ws.get("org_members", {
        org_id: org,
        user_id: target.userId,
      });
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          owner.req("PATCH", path, { status: "actioned", note: " Reviewed " }),
        ),
      );
      expect(new Set(responses.map((r) => r.report.handledAt)).size).toBe(1);
      const first = (await h.ctx.reports.get(id))!;
      expect(first).toMatchObject({
        handled_by: owner.userId,
        handled_note: "Reviewed",
      });
      const audit = async () =>
        (
          await owner.req("GET", `/v1/orgs/${org}/audit?action=report`)
        ).entries.filter((e: any) => e.target === id);
      expect(await audit()).toHaveLength(1);
      await owner.req("PATCH", path, { status: "actioned", note: "Reviewed" });
      expect(await h.ctx.reports.get(id)).toEqual(first);
      expect(await audit()).toHaveLength(1);
      await owner.req("PATCH", path, {
        status: "actioned",
        note: "New decision note",
      });
      expect(await audit()).toHaveLength(2);
      await owner.req("PATCH", path, {
        status: "open",
        note: "Ignored on reopen",
      });
      expect(await h.ctx.reports.get(id)).toMatchObject({
        status: "open",
        handled_at: null,
        handled_by: null,
        handled_note: null,
      });
      await owner.req("PATCH", path, { status: "open" });
      expect(await audit()).toHaveLength(3);
      expect(
        h.ctx.ws.get("org_members", { org_id: org, user_id: target.userId }),
      ).toEqual(before);
    });
  });
