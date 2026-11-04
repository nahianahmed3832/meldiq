import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`forum tag policy (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("enforces required/restricted tags server-side, protects text edits and rolls back invalid combined settings", async () => {
      const owner = await h.client("policyowner"),
        member = await h.client("policymember");
      owner.serverMessages = member.serverMessages = true;
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Forum policy fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const cid = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "policy-forum",
          format: "forum",
          scope: "ORG",
        })
      ).channel.id;
      await expectStatus(
        owner.req("PATCH", `/v1/conversations/${cid}`, {
          name: "Must roll back",
          noGifs: true,
          requireForumTag: true,
        }),
        400,
      );
      const unchanged = (await owner.req("GET", `/v1/conversations/${cid}`))
        .conversation;
      expect(unchanged).toMatchObject({
        name: "policy-forum",
        requireForumTag: false,
        options: { noGifs: false },
      });
      const configured = (
        await owner.req("PATCH", `/v1/conversations/${cid}`, {
          requireForumTag: true,
          forumTags: [{ name: "General" }, { name: "Staff", restricted: true }],
        })
      ).conversation;
      const general = configured.forumTags.find(
          (t: any) => t.name === "General",
        ).id,
        staff = configured.forumTags.find((t: any) => t.name === "Staff").id;
      await expectStatus(
        member.req("PATCH", `/v1/conversations/${cid}`, {
          requireForumTag: false,
        }),
        403,
      );
      await expectStatus(
        member.send(cid, { type: "text", text: "Missing tag" }),
        400,
      );
      await expectStatus(
        member.send(cid, {
          type: "text",
          text: "Unknown tag",
          tags: ["forged"],
        }),
        400,
      );
      await expectStatus(
        member.send(cid, {
          type: "text",
          text: "Forged moderator selection",
          tags: [staff],
        }),
        403,
      );
      const created = await member.send(cid, {
        type: "text",
        text: "Tagged root",
        title: "Tagged root",
        tags: [general],
      });
      await member.send(
        cid,
        { type: "edit", target: created.messageId, text: "Edited root" },
        "control",
      );
      await expectStatus(
        member.send(
          cid,
          {
            type: "edit",
            target: created.messageId,
            text: "Add staff",
            tags: [staff],
          },
          "control",
        ),
        403,
      );
      await expectStatus(
        member.send(
          cid,
          {
            type: "edit",
            target: created.messageId,
            text: "Remove all",
            tags: [],
          },
          "control",
        ),
        400,
      );
      await owner.send(cid, {
        type: "text",
        text: "Staff root",
        tags: [staff],
      });
      // Omission by an older manager client preserves the restricted flag and required policy.
      const preserved = (
        await owner.req("PATCH", `/v1/conversations/${cid}`, {
          forumTags: configured.forumTags.map((t: any) => ({
            id: t.id,
            name: t.name,
          })),
        })
      ).conversation;
      expect(preserved.requireForumTag).toBe(true);
      expect(
        preserved.forumTags.find((t: any) => t.id === staff).restricted,
      ).toBe(true);
      member.serverMessages = false;
      await expectStatus(
        member.send(cid, { type: "text", text: "Encrypted metadata bypass" }),
        400,
      );
      member.serverMessages = true;
      await member.send(cid, {
        type: "text",
        text: "Reply does not need a tag",
        threadRoot: created.messageId,
      });
    });
  });
