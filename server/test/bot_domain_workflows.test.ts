import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Harness } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";

/** Real bot credentials enter the native controllers, then a human reads the resulting state. */
describe.skipIf(!process.env.MELDIQ_TEST_PG_URL)(
  "bot native administration workflows",
  () => {
    let h: Harness,
      owner: GriipClient,
      member: GriipClient,
      outsider: GriipClient;
    let org: string,
      foreignOrg: string,
      bot: string,
      token: string,
      operatorRole: string;
    const scopes = [
      "communities.read",
      "channels.read",
      "channels.manage",
      "members.read",
      "roles.manage",
      "members.remove",
      "members.ban",
      "members.timeout",
      "members.nicknames",
      "members.invite",
      "expressions.manage",
      "events.manage",
      "webhooks.manage",
    ];
    const native = [
      "channels.create",
      "channels.manage",
      "channels.visibility",
      "roles.view",
      "roles.manage",
      "roles.assign",
      "roles.delegate",
      "members.view",
      "members.roles",
      "members.titles",
      "members.remove",
      "members.ban",
      "members.timeout",
      "members.nicknames",
      "members.invite",
      "members.invites.manage",
      "expressions.manage",
      "events.manage",
      "webhooks.manage",
    ];
    async function request(
      method: string,
      path: string,
      body?: unknown,
      bytes?: Buffer,
      status = 200,
    ) {
      const response = await fetch(h.baseUrl + "/v2/bot" + path, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          ...(bytes
            ? { "content-type": "application/octet-stream" }
            : body === undefined
              ? {}
              : { "content-type": "application/json" }),
        },
        ...(bytes
          ? { body: new Uint8Array(bytes) }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      expect(
        response.status,
        `${method} ${path}: ${JSON.stringify(value.error ?? { fields: Object.keys(value) })}`,
      ).toBe(status);
      return value;
    }
    async function addMember(person: GriipClient) {
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await person.req("POST", "/v1/invites/accept", { code });
    }
    beforeAll(async () => {
      h = await startServer();
      owner = await h.client("botworkflowowner");
      member = await h.client("botworkflowmember");
      outsider = await h.client("botworkflowoutsider");
      org = (
        await owner.req("POST", "/v1/orgs", { name: "Bot administration" })
      ).org.id;
      foreignOrg = (
        await outsider.req("POST", "/v1/orgs", { name: "Unrelated community" })
      ).org.id;
      await addMember(member);
      const made = await owner.req("POST", "/v2/developer/bots", {
        name: "Administration helper",
      });
      bot = made.bot.id;
      token = made.token;
      await owner.req("POST", `/v1/orgs/${org}/bots`, { botId: bot });
      await owner.req("PUT", `/v2/developer/bots/${bot}/permissions`, {
        permissions: scopes,
        rev: 0,
      });
      await owner.req("PUT", `/v1/orgs/${org}/bots/${bot}/permissions`, {
        permissions: scopes,
        manifestRev: 1,
        rev: 0,
      });
      operatorRole = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Explicit bot operator",
          permissions: native,
        })
      ).role.id;
      await owner.req("PUT", `/v1/roles/${operatorRole}/members/${bot}`);
    });
    afterAll(async () => h?.close());

    it("creates, edits and removes channels/categories with native overwrite persistence", async () => {
      expect((await request("GET", `/orgs/${org}`)).org.id).toBe(org);
      const category = (
        await request("POST", `/orgs/${org}/categories`, {
          name: "Bot category",
        })
      ).category;
      expect(
        (await request("GET", `/orgs/${org}/categories`)).categories.map(
          (c: { id: string }) => c.id,
        ),
      ).toContain(category.id);
      await request("PATCH", `/categories/${category.id}`, {
        name: "Edited category",
      });
      await request("PUT", `/categories/${category.id}/overwrites`, {
        subject: `user:${member.userId}`,
        deny: ["messages.post"],
      });
      expect(
        (await request("GET", `/categories/${category.id}/overwrites`))
          .overwrites,
      ).toContainEqual(
        expect.objectContaining({
          subject: `user:${member.userId}`,
          deny: ["messages.post"],
        }),
      );
      const channel = (
        await request("POST", `/orgs/${org}/channels`, {
          name: "bot-created-channel",
          autoJoin: true,
        })
      ).channel;
      expect(
        (await request("GET", `/orgs/${org}/channels`)).channels.map(
          (c: { id: string }) => c.id,
        ),
      ).toContain(channel.id);
      expect(
        (await request("GET", `/conversations/${channel.id}`)).conversation.id,
      ).toBe(channel.id);
      await request("PATCH", `/conversations/${channel.id}`, {
        name: "bot-edited-channel",
      });
      await request("PUT", `/conversations/${channel.id}/overwrites`, {
        subject: `user:${member.userId}`,
        deny: ["messages.post"],
      });
      expect(
        (await request("GET", `/conversations/${channel.id}/overwrites`))
          .overwrites,
      ).toContainEqual(
        expect.objectContaining({
          subject: `user:${member.userId}`,
          deny: ["messages.post"],
        }),
      );
      expect(
        (await owner.req("GET", `/v1/conversations/${channel.id}`)).conversation
          .name,
      ).toBe("bot-edited-channel");
      await request("PUT", `/conversations/${channel.id}/overwrites`, {
        subject: `user:${member.userId}`,
        allow: [],
        deny: [],
      });
      expect(
        (await request("GET", `/conversations/${channel.id}/overwrites`))
          .overwrites,
      ).not.toContainEqual(
        expect.objectContaining({ subject: `user:${member.userId}` }),
      );
      await request("PUT", `/categories/${category.id}/overwrites`, {
        subject: `user:${member.userId}`,
        allow: [],
        deny: [],
      });
      expect(
        (await request("GET", `/categories/${category.id}/overwrites`))
          .overwrites,
      ).not.toContainEqual(
        expect.objectContaining({ subject: `user:${member.userId}` }),
      );
      await request("DELETE", `/conversations/${channel.id}`, {
        confirmName: "bot-edited-channel",
      });
      await request("DELETE", `/categories/${category.id}`);
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/channels`)).channels.map(
          (c: { id: string }) => c.id,
        ),
      ).not.toContain(channel.id);
    });

    it("manages native roles/defaults without promoting a member to protected owner", async () => {
      const initial = await request("GET", `/orgs/${org}/roles`);
      const role = (
        await request("POST", `/orgs/${org}/roles`, {
          name: "Bot managed label",
          permissions: [],
        })
      ).role;
      const edited = (
        await request("PATCH", `/roles/${role.id}`, {
          baseRev: role.rev,
          name: "Edited label",
        })
      ).role;
      expect(edited.rev).toBe(role.rev + 1);
      await request("PUT", `/roles/${role.id}/members/${member.userId}`);
      expect(
        (await owner.req("GET", `/v1/roles/${role.id}/members`)).members.map(
          (m: { id: string }) => m.id,
        ),
      ).toContain(member.userId);
      await request("DELETE", `/roles/${role.id}/members/${member.userId}`);
      await request("PATCH", `/roles/${role.id}`, {
        baseRev: edited.rev,
        archived: true,
      });
      await request("DELETE", `/roles/${role.id}`, {
        confirmName: "Edited label",
      });
      await request("PUT", `/orgs/${org}/roles/everyone`, {
        permissions: initial.everyone.permissions,
      });
      await request(
        "PATCH",
        `/orgs/${org}/members/${member.userId}`,
        { role: "OWNER" },
        undefined,
        403,
      );
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/members`)).members.find(
          (m: { id: string }) => m.id === member.userId,
        ).orgRole,
      ).toBe("MEMBER");
    });

    it("applies member profile, timeout, removal and ban changes through native policy", async () => {
      expect(
        (await request("GET", `/orgs/${org}/members`)).members.map(
          (m: { id: string }) => m.id,
        ),
      ).toContain(member.userId);
      expect(
        (await request("GET", `/orgs/${org}/members/${member.userId}/profile`))
          .userId,
      ).toBe(member.userId);
      await request("PATCH", `/orgs/${org}/members/${member.userId}`, {
        title: "Bot assigned title",
      });
      await request("PUT", `/orgs/${org}/members/${member.userId}/nickname`, {
        nickname: "Community nickname",
      });
      const until = Date.now() + 60_000;
      await request("PUT", `/orgs/${org}/members/${member.userId}/timeout`, {
        until,
        reason: "Controlled integration test",
      });
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/members`)).members.find(
          (m: { id: string }) => m.id === member.userId,
        ),
      ).toMatchObject({
        title: "Bot assigned title",
        nickname: "Community nickname",
        timeoutUntil: until,
      });
      await request("PUT", `/orgs/${org}/members/${member.userId}/timeout`, {
        until: null,
      });
      const invited = await request("POST", `/orgs/${org}/invites`, {
        role: "MEMBER",
      });
      expect(
        (await request("GET", `/orgs/${org}/invites`)).invites.map(
          (i: { id: string }) => i.id,
        ),
      ).toContain(invited.invite.id);
      expect(
        JSON.stringify(await request("GET", `/orgs/${org}/invites`)),
      ).not.toContain(invited.invite.code);
      await request("DELETE", `/orgs/${org}/members/${member.userId}`);
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/members`)).members.map(
          (m: { id: string }) => m.id,
        ),
      ).not.toContain(member.userId);
      await addMember(member);
      await request("POST", `/orgs/${org}/bans`, {
        userId: member.userId,
        reason: "Controlled integration test",
      });
      expect(
        (await request("GET", `/orgs/${org}/bans`)).bans.map(
          (b: { userId: string }) => b.userId,
        ),
      ).toContain(member.userId);
      await request("DELETE", `/orgs/${org}/bans/${member.userId}`);
      expect((await request("GET", `/orgs/${org}/bans`)).bans).toEqual([]);
      await addMember(member);
      await request(
        "DELETE",
        `/orgs/${org}/members/${owner.userId}`,
        undefined,
        undefined,
        403,
      );
    });

    it("uses the native binary expression parser and preserves its validation", async () => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(100, 1),
      ]);
      const expression = (
        await request(
          "POST",
          `/orgs/${org}/expressions?name=bot_emoji`,
          undefined,
          png,
        )
      ).expression;
      expect(
        (await request("GET", `/orgs/${org}/expressions`)).expressions.map(
          (e: { id: string }) => e.id,
        ),
      ).toContain(expression.id);
      expect(
        Buffer.compare(
          await member.req("GET", `/v1/expressions/${expression.id}/image`),
          png,
        ),
      ).toBe(0);
      await request("PATCH", `/expressions/${expression.id}`, {
        name: "bot_renamed",
      });
      await request(
        "POST",
        `/orgs/${org}/expressions?name=unsafe`,
        undefined,
        Buffer.from("<svg onload='x()'/>"),
        400,
      );
      await request("DELETE", `/expressions/${expression.id}`);
      expect(
        (await request("GET", `/orgs/${org}/expressions`)).expressions,
      ).toEqual([]);
    });

    it("creates and edits native events, rejecting stale revisions before cancellation", async () => {
      const room = (
        await request("POST", `/orgs/${org}/channels`, {
          name: "Event room",
          voice: true,
          autoJoin: true,
        })
      ).channel.id;
      const startsAt = Date.now() + 3_600_000;
      const input = {
        roomId: room,
        title: "Bot scheduled event",
        startsAt,
        endsAt: startsAt + 3_600_000,
        timeZone: "UTC",
      };
      const meeting = (await request("POST", `/orgs/${org}/meetings`, input))
        .meeting;
      expect(
        (await request("GET", `/orgs/${org}/meetings`)).meetings.map(
          (m: { id: string }) => m.id,
        ),
      ).toContain(meeting.id);
      expect(
        (await request("GET", `/meetings/${meeting.id}`)).meeting.organizer.id,
      ).toBe(bot);
      const edited = (
        await request("PUT", `/meetings/${meeting.id}`, {
          ...input,
          title: "Edited bot event",
          rev: meeting.rev,
        })
      ).meeting;
      await request(
        "PUT",
        `/meetings/${meeting.id}`,
        { ...input, rev: meeting.rev },
        undefined,
        409,
      );
      expect(
        (await owner.req("GET", `/v1/meetings/${meeting.id}`)).meeting.title,
      ).toBe("Edited bot event");
      await request("POST", `/meetings/${meeting.id}/cancel`);
      expect(
        (await owner.req("GET", `/v1/meetings/${meeting.id}`)).meeting,
      ).toMatchObject({ cancelled: true, rev: edited.rev + 1 });
    });

    it("manages native webhooks while list responses omit credentials", async () => {
      const channel = (
        await request("POST", `/orgs/${org}/channels`, {
          name: "bot-hooks",
          autoJoin: true,
        })
      ).channel.id;
      const path = `/orgs/${org}/channels/${channel}/webhooks`;
      const made = await request(
        "POST",
        path,
        { name: "Bot managed hook" },
        undefined,
        201,
      );
      const list = await request("GET", path);
      expect(list.webhooks.map((w: { id: string }) => w.id)).toContain(
        made.webhook.id,
      );
      expect(JSON.stringify(list)).not.toContain(made.token);
      await request("PATCH", `${path}/${made.webhook.id}`, {
        name: "Renamed hook",
      });
      const rotated = await request("POST", `${path}/${made.webhook.id}/token`);
      expect(rotated.token).not.toBe(made.token);
      await request("DELETE", `${path}/${made.webhook.id}`);
      expect((await request("GET", path)).webhooks).toEqual([]);
    });

    it("denies foreign resources and observes role withdrawal on the next native write", async () => {
      await request(
        "GET",
        `/orgs/${foreignOrg}/channels`,
        undefined,
        undefined,
        403,
      );
      const category = (
        await outsider.req("POST", `/v1/orgs/${foreignOrg}/categories`, {
          name: "Foreign category",
        })
      ).category.id;
      await request(
        "PATCH",
        `/categories/${category}`,
        { name: "Intrusion" },
        undefined,
        403,
      );
      await owner.req("DELETE", `/v1/roles/${operatorRole}/members/${bot}`);
      await request(
        "POST",
        `/orgs/${org}/categories`,
        { name: "No longer permitted" },
        undefined,
        403,
      );
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/categories`)).categories.map(
          (c: { name: string }) => c.name,
        ),
      ).not.toContain("No longer permitted");
    });
  },
);
