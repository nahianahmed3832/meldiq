import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
import {
  prepareManagedPoll,
  reserveManagedPoll,
} from "../src/modules/messaging/managedPolls.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`managed poll authority and quiz disclosure (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("keeps answer keys and anonymous identities out of message history, validates ballots and closes once under concurrent requests", async () => {
      const owner = await h.client("quizowner"),
        voter = await h.client("quizvoter"),
        named = await h.client("quiznamed"),
        outside = await h.client("quizoutside");
      for (const c of [owner, voter, named, outside]) c.serverMessages = true;
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Quiz fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, {
          role: "MEMBER",
          maxUses: 3,
        })
      ).invite.code;
      for (const c of [voter, named])
        await c.req("POST", "/v1/invites/accept", { code });
      const cid = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "quiz",
          scope: "ORG",
        })
      ).channel.id;
      const definition = {
        version: 1,
        question: "Which answer?",
        options: [
          { id: "o1", text: "First" },
          { id: "o2", text: "Second" },
        ],
        multi: false,
        quiz: true,
        reveal: "after_close",
        correctOptionIds: ["o2"],
      };
      await voter.connect();
      const id = `m_quiz_${Date.now()}`;
      await owner.send(
        cid,
        { type: "text", managedPoll: definition },
        "message",
        id,
      );
      const history = await voter.req(
        "GET",
        `/v2/conversations/${cid}/messages`,
      );
      const payload = history.messages.find((m: any) => m.id === id).payload;
      expect(payload.managedPoll).toMatchObject({
        quiz: true,
        reveal: "after_close",
      });
      expect(payload.managedPoll).not.toHaveProperty("correctOptionIds");
      expect(JSON.stringify(history)).not.toMatch(
        /answer_key|fingerprint|correctOptionIds/,
      );
      expect(payload.text).toContain("Which answer?");
      const path = `/v1/polls/${id}`;
      const unrelated = `m_retry_${Date.now()}`;
      await named.send(
        cid,
        { type: "text", text: "Existing accepted message" },
        "message",
        unrelated,
      );
      await named.send(
        cid,
        { type: "delete", target: id },
        "control",
        unrelated,
      );
      expect(h.ctx.ws.get("managed_polls", { message_id: id })).toBeDefined();
      for (const c of [owner, voter])
        expect((await c.req("GET", path)).correctOptionIds).toBeNull();
      await expectStatus(outside.req("GET", path), 404);
      await expectStatus(voter.req("POST", `${path}/close`, {}), 403);
      await expectStatus(
        voter.req("PUT", `${path}/vote`, { choices: ["o1", "o2"] }),
        400,
      );
      await expectStatus(
        voter.req("PUT", `${path}/vote`, { choices: ["unknown"] }),
        400,
      );
      await expectStatus(
        voter.req("PUT", `${path}/vote`, { choices: ["o1", "o1"] }),
        400,
      );
      await expectStatus(
        voter.send(
          cid,
          { type: "vote", target: id, choices: ["o2"], anonymous: true },
          "control",
        ),
        400,
      );
      const first = await voter.req("PUT", `${path}/vote`, {
        choices: ["o2"],
        anonymous: true,
      });
      const retry = await voter.req("PUT", `${path}/vote`, { choices: ["o2"] });
      expect(retry.rev).toBe(first.rev);
      expect(retry.mine.anonymous).toBe(true);
      await named.req("PUT", `${path}/vote`, {
        choices: ["o1"],
        anonymous: false,
      });
      const visible = await named.req("GET", path);
      expect(visible.total).toBe(2);
      expect(visible.correctOptionIds).toBeNull();
      expect(visible.voters).toEqual(
        expect.arrayContaining([
          { userId: null, choices: ["o2"] },
          { userId: named.userId, choices: ["o1"] },
        ]),
      );
      expect(JSON.stringify(visible)).not.toContain(voter.userId);
      // Votes go through the poll API, never identifiable message controls or relay envelopes.
      const withVotes = await named.req(
        "GET",
        `/v2/conversations/${cid}/messages`,
      );
      expect(
        withVotes.changes.filter((m: any) => m.payload.type === "vote"),
      ).toHaveLength(0);
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${voter.userId}`,
        allow: [],
        deny: ["messages.post"],
      });
      await expectStatus(
        voter.req("PUT", `${path}/vote`, { choices: [] }),
        403,
      );
      const closed = await Promise.all([
        owner.req("POST", `${path}/close`, {}),
        owner.req("POST", `${path}/close`, {}),
      ]);
      expect(closed[0].rev).toBe(closed[1].rev);
      expect((await voter.req("GET", path)).correctOptionIds).toEqual(["o2"]);
      await expectStatus(
        named.req("PUT", `${path}/vote`, { choices: [] }),
        409,
      );
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${voter.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      await expectStatus(voter.req("GET", path), 404);
      await owner.send(cid, { type: "delete", target: id }, "control");
      await expectStatus(named.req("GET", path), 404);
      expect(h.ctx.ws.get("managed_polls", { message_id: id })).toBeUndefined();
      expect(h.ctx.ws.count("managed_poll_votes", { message_id: id })).toBe(0);
    });
    it("rejects malformed quiz definitions and cannot expose an unpublished reservation; expiry is server-owned", async () => {
      const owner = await h.client("quizexpiry");
      owner.serverMessages = true;
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Quiz expiry fixture" })
      ).org.id;
      const cid = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "expiry",
          scope: "ORG",
        })
      ).channel.id;
      const poll = {
        question: "Expiry",
        options: [
          { id: "a", text: "One" },
          { id: "b", text: "Two" },
        ],
        multi: false,
        quiz: true,
        correctOptionIds: ["a"],
        endsAt: Date.now() + 3600000,
      };
      for (const bad of [
        { ...poll, correctOptionIds: [] },
        { ...poll, correctOptionIds: ["foreign"] },
        { ...poll, correctOptionIds: ["a", "b"] },
        { ...poll, endsAt: Date.now() - 1000 },
        { ...poll, options: [poll.options[0], poll.options[0]] },
      ])
        await expectStatus(
          owner.send(cid, { type: "text", managedPoll: bad }),
          400,
        );
      const id = `m_expiry_${Date.now()}`;
      await owner.send(cid, { type: "text", managedPoll: poll }, "message", id);
      const clock = vi.spyOn(Date, "now").mockReturnValue(poll.endsAt + 1);
      try {
        expect(
          (
            await owner.send(
              cid,
              { type: "text", managedPoll: poll },
              "message",
              id,
            )
          ).duplicate,
        ).toBe(true);
      } finally {
        clock.mockRestore();
      }
      const stored = h.ctx.ws.get<{ definition: string }>("managed_polls", {
        message_id: id,
      })!;
      await h.ctx.ws.write((w) =>
        w.update(
          "managed_polls",
          { message_id: id },
          {
            definition: JSON.stringify({
              ...JSON.parse(stored.definition),
              endsAt: Date.now() - 1,
            }),
          },
        ),
      );
      await expectStatus(
        owner.req("PUT", `/v1/polls/${id}/vote`, { choices: ["a"] }),
        409,
      );
      expect(
        (await owner.req("GET", `/v1/polls/${id}`)).correctOptionIds,
      ).toEqual(["a"]);
      const pending = {
        conversationId: cid,
        messageId: `m_pending_${Date.now()}`,
        cls: "message" as const,
        sentAt: Date.now(),
        payload: { type: "text", managedPoll: poll },
      };
      const reservation = prepareManagedPoll(pending)!;
      await reserveManagedPoll(h.ctx, pending, owner.userId, reservation);
      await expectStatus(
        owner.req("GET", `/v1/polls/${pending.messageId}`),
        404,
      );
    });
  });
