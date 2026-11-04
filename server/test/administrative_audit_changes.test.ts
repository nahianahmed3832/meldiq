import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  auditChanges,
  safeAuditChanges,
} from "../src/modules/organizations/adminChanges.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
it("allows only explicit administrative values and never serializes content, credentials or private evidence", () => {
  const secrets = {
    password: "PRIVATE_PASSWORD",
    message_text: "PRIVATE_MESSAGE",
    note: "PRIVATE_REPORT",
    content: "PRIVATE_CONTENT",
    statement: "PRIVATE_APPLICATION",
  };
  expect(auditChanges({}, secrets)).toEqual([]);
  expect(
    safeAuditChanges(
      Object.entries(secrets).map(([field, after]) => ({
        field,
        before: null,
        after,
      })),
    ),
  ).toEqual([]);
  expect(
    safeAuditChanges([
      { field: "permissions", before: [], after: ["PRIVATE_TOKEN"] },
      { field: "color", before: null, after: "PRIVATE_PASSWORD" },
      { field: "starts_at", before: 1, after: { password: "PRIVATE" } },
    ]),
  ).toEqual([]);
  expect(
    auditChanges(
      { permissions: '["messages.post","messages.attach"]' },
      { permissions: ["messages.attach", "messages.post"] },
    ),
  ).toEqual([]);
});
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`administrative before/after (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("projects real role/channel changes only to authorized readers and excludes every private field", async () => {
      const owner = await h.client("auditowner"),
        member = await h.client("auditmember");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Audit fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const role = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Audit role",
          permissions: [],
        })
      ).role;
      await owner.req("PATCH", `/v1/roles/${role.id}`, {
        baseRev: role.rev,
        color: "#A3E635",
        permissions: ["messages.post"],
        description: "PRIVATE_DESCRIPTION",
      });
      const channel = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "audited-room",
          scope: "ORG",
        })
      ).channel.id;
      await owner.req("PATCH", `/v1/conversations/${channel}`, {
        slowmodeSec: 10,
        topic: "PRIVATE_TOPIC",
      });
      h.ctx.audit({
        actorId: owner.userId,
        orgId: org,
        action: "role.test",
        changes: [
          { field: "note", before: null, after: "PRIVATE_REPORT" },
          { field: "password", before: null, after: "PRIVATE_PASSWORD" },
        ],
      });
      // Even safe-looking administrative fields cannot be attached to a report action.
      h.ctx.audit({
        actorId: owner.userId,
        orgId: org,
        action: "report.test",
        changes: [{ field: "color", before: null, after: "#A3E635" }],
      });
      const entries = async () =>
        (await owner.req("GET", `/v1/orgs/${org}/audit`)).entries;
      await vi.waitFor(async () =>
        expect(
          (await entries()).some((e: any) => e.action === "report.test"),
        ).toBe(true),
      );
      const rows = await entries();
      const roleChange = rows.find(
        (e: any) => e.action === "role.update" && e.target === role.id,
      );
      expect(roleChange.changes).toEqual(
        expect.arrayContaining([
          { field: "Color", before: null, after: "#A3E635" },
          { field: "Permission grants", before: [], after: ["messages.post"] },
        ]),
      );
      expect(
        rows.find((e: any) => e.action === "channel.slowmode").changes,
      ).toEqual([{ field: "Slowmode seconds", before: 0, after: 10 }]);
      expect(
        rows.find((e: any) => e.action === "report.test"),
      ).not.toHaveProperty("changes");
      expect(JSON.stringify(rows)).not.toMatch(
        /PRIVATE_DESCRIPTION|PRIVATE_TOPIC|PRIVATE_REPORT|PRIVATE_PASSWORD/,
      );
      await expectStatus(member.req("GET", `/v1/orgs/${org}/audit`), 403);
      const reader = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Scoped audit reader",
          permissions: ["audit.view"],
        })
      ).role;
      await owner.req("PUT", `/v1/roles/${reader.id}/members/${member.userId}`);
      expect(
        (await member.req("GET", `/v1/orgs/${org}/audit`)).entries.find(
          (e: any) => e.action === "channel.slowmode",
        ).changes,
      ).toHaveLength(1);
      await owner.req("PUT", `/v1/conversations/${channel}/overwrites`, {
        subject: `user:${member.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      const scoped = (await member.req("GET", `/v1/orgs/${org}/audit`)).entries;
      expect(
        scoped.find((e: any) => e.action === "channel.slowmode").changes ?? [],
      ).toEqual([]);
      expect(
        scoped.find(
          (e: any) => e.action === "role.update" && e.target === role.id,
        ).changes,
      ).toHaveLength(2);
    });
  });
