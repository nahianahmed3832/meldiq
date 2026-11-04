import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`event authority and covers (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        WORKFLOW_TICK_MS: "0",
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("delegates management without channel visibility bypass, preserves organizer rights, atomically rejects stale edits and sends one authorized notice", async () => {
      const owner = await h.client("evowner"),
        member = await h.client("evmember"),
        manager = await h.client("evmanager");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Event fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, {
          role: "MEMBER",
          maxUses: 2,
        })
      ).invite.code;
      for (const c of [member, manager])
        await c.req("POST", "/v1/invites/accept", { code });
      const room = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "event-room",
          voice: true,
          scope: "ORG",
        })
      ).channel.id;
      const input = {
        roomId: room,
        title: "A private fixture",
        startsAt: Date.now() + 300000,
        endsAt: Date.now() + 1800000,
        timeZone: "UTC",
        participantIds: [member.userId],
      };
      const m = (await owner.req("POST", `/v1/orgs/${org}/meetings`, input))
        .meeting;
      await expectStatus(
        manager.req("PUT", `/v1/meetings/${m.id}`, { ...input, rev: m.rev }),
        403,
      );
      const role = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Event manager",
          permissions: ["events.manage"],
        })
      ).role;
      await owner.req("PUT", `/v1/roles/${role.id}/members/${manager.userId}`);
      expect(
        (await manager.req("GET", `/v1/meetings/${m.id}`)).meeting.canEdit,
      ).toBe(true);
      const updates = await Promise.allSettled(
        ["First", "Second"].map((title) =>
          manager.req("PUT", `/v1/meetings/${m.id}`, {
            ...input,
            title,
            rev: m.rev,
          }),
        ),
      );
      expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(updates.filter((r) => r.status === "rejected")).toHaveLength(1);
      const active = (await owner.req("GET", `/v1/meetings/${m.id}`)).meeting;
      const jpeg = await sharp({
        create: { width: 200, height: 80, channels: 3, background: "#a3e635" },
      })
        .jpeg()
        .toBuffer();
      await expectStatus(
        member.req(
          "PUT",
          `/v1/meetings/${m.id}/cover?rev=${active.rev}`,
          undefined,
          jpeg,
        ),
        403,
      );
      await expectStatus(
        manager.req(
          "PUT",
          `/v1/meetings/${m.id}/cover?rev=${active.rev}`,
          undefined,
          Buffer.from("bad"),
        ),
        400,
      );
      let covered = (
        await manager.req(
          "PUT",
          `/v1/meetings/${m.id}/cover?rev=${active.rev}`,
          undefined,
          jpeg,
        )
      ).meeting;
      expect(covered.coverId).toBeTruthy();
      const bytes = await member.req("GET", `/v1/meetings/${m.id}/cover`);
      expect((await sharp(bytes).metadata()).format).toBe("jpeg");
      await expectStatus(
        owner.req("DELETE", `/v1/meetings/${m.id}/cover?rev=${active.rev}`),
        409,
      );
      const oldCover = covered.coverId;
      const removed = (
        await manager.req(
          "DELETE",
          `/v1/meetings/${m.id}/cover?rev=${covered.rev}`,
        )
      ).meeting;
      expect(removed.coverId).toBeNull();
      expect(await h.ctx.blobs.get("profile-photos", oldCover)).toBeNull();
      covered = (
        await manager.req(
          "PUT",
          `/v1/meetings/${m.id}/cover?rev=${removed.rev}`,
          undefined,
          jpeg,
        )
      ).meeting;
      // A prior invitation cannot override a later channel denial.
      await owner.req("PUT", `/v1/conversations/${room}/overwrites`, {
        subject: `user:${member.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      await expectStatus(member.req("GET", `/v1/meetings/${m.id}`), 404);
      await expectStatus(member.req("GET", `/v1/meetings/${m.id}/cover`), 404);
      const send = vi.spyOn(h.ctx.hub, "sendToUsers");
      const notices = await Promise.all([
        h.ctx.meetings.notifySoon(),
        h.ctx.meetings.notifySoon(),
      ]);
      expect(notices.reduce((a, b) => a + b, 0)).toBe(1);
      const sent = send.mock.calls.filter(
        ([, frame]) => frame.t === "meeting.soon",
      );
      expect(sent).toHaveLength(1);
      expect([...sent[0][0]]).not.toContain(member.userId);
      send.mockRestore();
      await owner.req(
        "DELETE",
        `/v1/roles/${role.id}/members/${manager.userId}`,
      );
      expect(
        (await owner.req("GET", `/v1/meetings/${m.id}`)).meeting.canEdit,
      ).toBe(true);
      await expectStatus(
        manager.req("POST", `/v1/meetings/${m.id}/cancel`),
        403,
      );
      await Promise.all([
        owner.req("POST", `/v1/meetings/${m.id}/cancel`),
        owner.req("POST", `/v1/meetings/${m.id}/cancel`),
      ]);
      const audits = (
        await owner.req("GET", `/v1/orgs/${org}/audit?action=meeting`)
      ).entries;
      expect(
        audits.filter(
          (e: any) => e.action === "meeting.cancel" && e.target === m.id,
        ),
      ).toHaveLength(1);
      expect(
        await h.ctx.blobs.get("profile-photos", covered.coverId),
      ).not.toBeNull();
      await owner.req("DELETE", `/v1/conversations/${room}`, {
        confirmName: "event-room",
      });
      expect(
        await h.ctx.blobs.get("profile-photos", covered.coverId),
      ).toBeNull();
      await expectStatus(owner.req("GET", `/v1/meetings/${m.id}/cover`), 404);
    });
  });
