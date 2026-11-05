import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, expectStatus, type Harness } from "./support/harness.js";
import { deleteThreadBatch } from "../src/modules/messaging/threadRoutes.js";
import type { ThreadRow } from "../src/modules/messaging/threadManagement.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`thread lifecycle (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      // Explicit MONGODB_DOMAINS also selects the legacy harness, even when it is empty.
      h = await startServer(backend === "postgres" ? {} : {
        MONGODB_DOMAINS:
          backend === "mongodb"
            ? "workspace,conversations,history,files,calls"
            : "",
      });
      expect(Boolean(h.ctx.postgres)).toBe(backend === "postgres");
    });
    afterAll(async () => h?.close());
    async function fixture(format = "text") {
      const [owner, author, peer, outside] = await Promise.all(
        ["thowner", "thauthor", "thpeer", "thoutside"].map((n) => h.client(n)),
      );
      for (const c of [owner, author, peer, outside]) c.serverMessages = true;
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Thread authority" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, {
          role: "MEMBER",
          maxUses: 3,
        })
      ).invite.code;
      for (const c of [author, peer])
        await c.req("POST", "/v1/invites/accept", { code });
      const cid = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "threads",
          format,
          scope: "ORG",
        })
      ).channel.id;
      const root = `m_thread_${author.userId}_${Date.now()}`;
      await author.send(
        cid,
        {
          type: "text",
          text: "Root private text",
          ...(format === "forum" ? { title: "Forum parent" } : {}),
        },
        "message",
        root,
      );
      return {
        owner,
        author,
        peer,
        outside,
        org,
        cid,
        root,
        path: `/v1/threads/${root}`,
      };
    }
    it("separates author close/reopen from moderator lock, rejects stale changes and controls current reply/vote authority", async () => {
      const { owner, author, peer, outside, cid, root, path } = await fixture();
      await peer.connect();
      await author.connect();
      let state = await author.req("GET", path);
      expect(state).toMatchObject({
        canClose: true,
        canLock: false,
        canReply: true,
        deletesParent: false,
      });
      expect((await peer.req("GET", path)).canClose).toBe(false);
      await expectStatus(outside.req("GET", path), 404);
      await expectStatus(
        peer.req("PATCH", path, { baseRev: 0, closed: true }),
        403,
      );
      await expectStatus(
        author.req("PATCH", path, { baseRev: 0, locked: true }),
        403,
      );
      const poll = `m_thread_poll_${Date.now()}`;
      await peer.send(
        cid,
        {
          type: "text",
          threadRoot: root,
          managedPoll: {
            question: "Vote",
            options: [
              { id: "a", text: "A" },
              { id: "b", text: "B" },
            ],
            multi: false,
          },
        },
        "message",
        poll,
      );
      state = await author.req("PATCH", path, {
        baseRev: state.rev,
        closed: true,
      });
      expect(state.canReply).toBe(false);
      await expectStatus(
        peer.send(cid, { type: "text", text: "late", threadRoot: root }),
        409,
      );
      await expectStatus(
        peer.req("PUT", `/v1/polls/${poll}/vote`, { choices: ["a"] }),
        409,
      );
      await expectStatus(
        author.req("PATCH", path, { baseRev: 0, closed: false }),
        409,
      );
      state = await author.req("PATCH", path, {
        baseRev: state.rev,
        closed: false,
      });
      state = await owner.req("PATCH", path, {
        baseRev: state.rev,
        locked: true,
      });
      expect(state).toMatchObject({ locked: true, closed: true });
      await expectStatus(
        author.req("PATCH", path, { baseRev: state.rev, closed: false }),
        403,
      );
      await expectStatus(
        author.req("PATCH", path, { baseRev: state.rev, locked: false }),
        403,
      );
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${peer.userId}`,
        allow: ["threads.manage"],
        deny: [],
      });
      expect((await peer.req("GET", path)).canLock).toBe(true);
      state = await peer.req("PATCH", path, {
        baseRev: state.rev,
        locked: false,
        closed: false,
      });
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${peer.userId}`,
        allow: [],
        deny: ["threads.manage"],
      });
      await expectStatus(
        peer.req("PATCH", path, { baseRev: state.rev, locked: true }),
        403,
      );
      await peer.req("PUT", `/v1/polls/${poll}/vote`, { choices: ["a"] });
      await author.req("PUT", `${path}/follow`, { following: false });
      expect((await author.req("GET", path)).following).toBe(false);
      const push = vi.spyOn(h.ctx.hub, "pushQueued");
      try {
        const ordinary = `m_unfollowed_${Date.now()}`;
        await peer.send(
          cid,
          { type: "text", text: "Quiet reply", threadRoot: root },
          "message",
          ordinary,
        );
        expect(
          push.mock.calls.find(
            (call) =>
              call[0] === author.deviceId &&
              call[1].some((row) => row.message_id === ordinary),
          )?.[2]?.wake,
        ).toBe(false);
        const direct = `m_directmention_${Date.now()}`;
        await peer.send(
          cid,
          {
            type: "text",
            text: "Direct mention",
            threadRoot: root,
            mentions: [author.userId],
          },
          "message",
          direct,
        );
        expect(
          push.mock.calls.find(
            (call) =>
              call[0] === author.deviceId &&
              call[1].some((row) => row.message_id === direct),
          )?.[2]?.wake,
        ).toBe(true);
      } finally {
        push.mockRestore();
      }

      expect(
        (await peer.req("GET", "/v1/me/thread-preferences")).preferences,
      ).toEqual([]);
      expect(
        (await author.req("GET", "/v1/me/thread-preferences?limit=1"))
          .preferences,
      ).toEqual([{ rootId: root, conversationId: cid, following: false }]);
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${author.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      await expectStatus(author.req("GET", path), 404);
      expect(
        (await author.req("GET", "/v1/me/thread-preferences")).preferences,
      ).toEqual([]);
    });
    it("imports an old local follow only when this account has no existing choice", async () => {
      const { author, peer, root, cid, path } = await fixture();
      expect(await author.req("PUT", `${path}/follow`, { following: true, ifUnset: true })).toEqual({ rootId: root, following: true });
      await author.req("PUT", `${path}/follow`, { following: false });
      const beforeImport = h.ctx.ws.get<{ updated_at: number }>("thread_preferences", { root_id: root, user_id: author.userId })!.updated_at;
      const events = vi.spyOn(h.ctx.hub, "sendToUser");
      expect(await author.req("PUT", `${path}/follow`, { following: true, ifUnset: true })).toEqual({ rootId: root, following: false });
      expect(h.ctx.ws.get<{ updated_at: number }>("thread_preferences", { root_id: root, user_id: author.userId })!.updated_at).toBe(beforeImport);
      expect(events.mock.calls.filter(([, event]) => event.t === "thread.preference")).toHaveLength(0);
      events.mockRestore();
      expect((await author.req("GET", "/v1/me/thread-preferences")).preferences).toContainEqual({ rootId: root, conversationId: cid, following: false });
      expect((await peer.req("GET", "/v1/me/thread-preferences")).preferences).not.toContainEqual(expect.objectContaining({ rootId: root }));
      expect((await author.req("GET", "/v1/server-info")).features).toContain("thread-follow-import");
      await author.req("PUT", `${path}/follow`, { following: true, ifUnset: false });
      expect((await author.req("GET", path)).following).toBe(true);
    });

    it("keeps a concurrent explicit opt-out when a device imports old local follows", async () => {
      const { author, cid, root } = await fixture();
      for (let n = 0; n < 3; n++) {
        const id = n ? `${root}_${n}` : root;
        if (n) await author.send(cid, { type: "text", text: "Another root" }, "message", id);
        await Promise.all([
          author.req("PUT", `/v1/threads/${id}/follow`, { following: true, ifUnset: true }),
          author.req("PUT", `/v1/threads/${id}/follow`, { following: false }),
        ]);
        expect((await author.req("GET", `/v1/threads/${id}`)).following).toBe(false);
      }
    });

    it("keeps conditional imports behind current thread history and membership checks", async () => {
      const { owner, author, outside, root, cid, path } = await fixture();
      await author.req("PUT", `${path}/follow`, { following: false });
      await expectStatus(outside.req("PUT", `${path}/follow`, { following: true, ifUnset: true }), 404);
      await expectStatus(author.req("PUT", `${path}/follow`, { following: true, ifUnset: "yes" }), 400);
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, { subject: `user:${author.userId}`, allow: [], deny: ["channels.view"] });
      await expectStatus(author.req("PUT", `${path}/follow`, { following: true, ifUnset: true }), 404);
      expect(h.ctx.ws.get<{ following: number }>("thread_preferences", { root_id: root, user_id: author.userId })?.following).toBe(0);
    });

    it("deletes all replies in bounded resumable batches, retains a text parent and forbids format-race widening", async () => {
      const { owner, author, peer, cid, root, path } = await fixture();
      for (let i = 0; i < 29; i++)
        await peer.send(cid, {
          type: "text",
          text: `Reply ${i}`,
          threadRoot: root,
        });
      await author.req("PUT", `${path}/follow`, { following: true });
      let state = await author.req("GET", path);
      await expectStatus(
        author.req("POST", `${path}/delete`, {
          baseRev: state.rev,
          deleteParent: true,
        }),
        409,
      );
      state = await author.req("POST", `${path}/delete`, {
        baseRev: state.rev,
        deleteParent: false,
      });
      expect(state.deleting).toBe(true);
      await expectStatus(
        peer.send(cid, { type: "text", text: "late", threadRoot: root }),
        409,
      );
      // A persisted interrupted job is visible and may only be resumed by current authority.
      await h.ctx.ws.write((w) =>
        w.update(
          "message_threads",
          { root_id: root },
          { deletion_error: "retry_required" },
        ),
      );
      await expectStatus(
        peer.req("POST", `${path}/delete`, {
          baseRev: state.rev,
          deleteParent: false,
        }),
        403,
      );
      state = await author.req("GET", path);
      state = await author.req("POST", `${path}/delete`, {
        baseRev: state.rev,
        deleteParent: false,
      });
      for (let i = 0; i < 4 && !state.deleted; i++) {
        await deleteThreadBatch(h.ctx, root);
        state = await author.req("GET", path);
      }
      expect(state).toMatchObject({
        deleted: true,
        deleting: false,
        deletedReplies: 29,
      });
      expect(
        (await h.ctx.messages.changesTo(cid, root, "delete")).filter(
          (c) => c.audience !== "self",
        ),
      ).toHaveLength(0);
      expect(h.ctx.ws.count("thread_preferences", { root_id: root })).toBe(0);
      const page = await owner.req(
        "GET",
        `/v2/conversations/${cid}/message-collections?kind=thread&root=${root}`,
      );
      expect(page.messages).toHaveLength(29);
      expect(
        page.changes.filter((c: any) => c.payload.type === "delete"),
      ).toHaveLength(29);
      const again = await author.req("POST", `${path}/delete`, {
        baseRev: state.rev,
        deleteParent: false,
      });
      expect(again.rev).toBe(state.rev);
      await expectStatus(
        author.req("PUT", `${path}/follow`, { following: true }),
        409,
      );
    });
    it("deletes a forum parent last, settles private poll data and stops an interrupted job on revoked authority", async () => {
      const { owner, author, peer, cid, root, path } = await fixture("forum");
      const reply = `m_thread_quiz_${Date.now()}`;
      await peer.send(
        cid,
        {
          type: "text",
          threadRoot: root,
          managedPoll: {
            question: "Cleanup",
            options: [
              { id: "a", text: "A" },
              { id: "b", text: "B" },
            ],
            multi: false,
          },
        },
        "message",
        reply,
      );
      await peer.req("PUT", `/v1/polls/${reply}/vote`, { choices: ["a"] });
      let state = await author.req("GET", path);
      await author.req("POST", `${path}/delete`, {
        baseRev: state.rev,
        deleteParent: true,
      });
      await h.ctx.ws.write((w) =>
        w.update(
          "message_threads",
          { root_id: root },
          { deletion_error: "retry_required" },
        ),
      );
      await owner.req("PUT", `/v1/conversations/${cid}/overwrites`, {
        subject: `user:${author.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      await h.ctx.ws.write((w) =>
        w.update(
          "message_threads",
          { root_id: root },
          { deletion_error: null },
        ),
      );
      await deleteThreadBatch(h.ctx, root);
      expect(
        h.ctx.ws.get<ThreadRow>("message_threads", { root_id: root })
          ?.deletion_error,
      ).toBe("access_changed");
      expect(await h.ctx.messages.changesTo(cid, root, "delete")).toHaveLength(
        0,
      );
      state = await owner.req("GET", path);
      await owner.req("POST", `${path}/delete`, {
        baseRev: state.rev,
        deleteParent: true,
      });
      for (let i = 0; i < 4; i++) await deleteThreadBatch(h.ctx, root);
      expect((await owner.req("GET", path)).deleted).toBe(true);
      const rootDelete = (
        await h.ctx.messages.changesTo(cid, root, "delete")
      )[0];
      const replyDelete = (
        await h.ctx.messages.changesTo(cid, reply, "delete")
      )[0];
      expect(rootDelete.server_ts).toBeGreaterThanOrEqual(
        replyDelete.server_ts,
      );
      expect(
        h.ctx.ws.get("managed_polls", { message_id: reply }),
      ).toBeUndefined();
      expect(h.ctx.ws.count("managed_poll_votes", { message_id: reply })).toBe(
        0,
      );
    });
  });
