import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`associated voice text (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb"
            ? "workspace,conversations,files,calls,history"
            : "",
      });
    });
    afterAll(async () => h?.close());
    it("uses current channel/text authority, requires no audio membership and preserves independent voice denial", async () => {
      const owner = await h.client("vcowner"),
        member = await h.client("vcmember"),
        outsider = await h.client("vcoutsider");
      owner.serverMessages =
        member.serverMessages =
        outsider.serverMessages =
          true;
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Voice chat fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const room = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "room-chat",
          voice: true,
          scope: "ORG",
        })
      ).channel.id;
      const overwrite = (deny: string[]) =>
        owner.req("PUT", `/v1/conversations/${room}/overwrites`, {
          subject: `user:${member.userId}`,
          allow: [],
          deny,
        });
      await overwrite(["voice.connect", "voice.speak"]);
      expect(
        (await member.req("GET", `/v1/conversations/${room}`)).conversation,
      ).toMatchObject({ canPost: true, canConnect: false });
      await member.send(room, {
        type: "text",
        text: "Text without an audio session",
      });
      expect(
        (
          await member.req("GET", `/v2/conversations/${room}/messages`)
        ).messages.some(
          (m: any) => m.payload.text === "Text without an audio session",
        ),
      ).toBe(true);
      expect(await h.ctx.calls.liveIn([room])).toEqual([]);
      await expectStatus(
        member.req("POST", "/v1/calls", { conversationId: room }),
        403,
      );
      await expectStatus(
        member.send(
          room,
          { type: "call_key_request", callId: "call_permission_fixture" },
          "control",
        ),
        403,
      );
      await expectStatus(
        outsider.send(room, { type: "text", text: "Outside" }),
        404,
      );
      await overwrite(["messages.post"]);
      await expectStatus(
        member.send(room, { type: "text", text: "Denied text" }),
        403,
      );
      expect(
        (await member.req("GET", `/v1/conversations/${room}`)).conversation
          .canConnect,
      ).toBe(true);
      await member.send(
        room,
        { type: "call_key_request", callId: "call_permission_fixture" },
        "control",
      );
      await owner.req(
        "PUT",
        `/v1/orgs/${org}/members/${member.userId}/timeout`,
        { until: Date.now() + 60000 },
      );
      await expectStatus(
        member.send(
          room,
          { type: "call_key_request", callId: "call_permission_fixture" },
          "control",
        ),
        403,
      );
      await owner.req(
        "PUT",
        `/v1/orgs/${org}/members/${member.userId}/timeout`,
        { until: null },
      );
      await overwrite(["channels.view"]);
      await expectStatus(
        member.req("GET", `/v2/conversations/${room}/messages`),
        404,
      );
      await expectStatus(
        member.send(room, { type: "text", text: "Revoked" }),
        404,
      );
      expect(await h.ctx.calls.liveIn([room])).toEqual([]);
    });
  });
