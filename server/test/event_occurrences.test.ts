import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextEventStart } from "../src/modules/organizations/eventRepeat.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";

for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`event locations and occurrence scopes (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        WORKFLOW_TICK_MS: "0",
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("validates external locations, enforces visibility and separates current-occurrence changes, future RSVPs and series cancellation", async () => {
      const owner = await h.client("scopeowner"),
        member = await h.client("scopemember"),
        outsider = await h.client("scopeoutside");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Event scope fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const channel = (
        await owner.req("POST", `/v1/orgs/${org}/channels`, {
          name: "event-visibility",
          scope: "ORG",
        })
      ).channel.id;
      const startsAt = Date.now() + 3600000;
      const input = {
        roomId: channel,
        externalLocation: "https://events.example.test/meet",
        title: "Weekly external event",
        startsAt,
        endsAt: startsAt + 3600000,
        timeZone: "America/New_York",
        repeat: "weekly",
        participantIds: [member.userId],
      };
      for (const externalLocation of [
        "javascript:alert(1)",
        "https://name:password@example.test",
        "http://example.test",
        "Place\nwith control",
      ])
        await expectStatus(
          owner.req("POST", `/v1/orgs/${org}/meetings`, {
            ...input,
            externalLocation,
          }),
          400,
        );
      await expectStatus(
        owner.req("POST", `/v1/orgs/${org}/meetings`, {
          ...input,
          externalLocation: null,
        }),
        400,
      );
      let event = (await owner.req("POST", `/v1/orgs/${org}/meetings`, input))
        .meeting;
      expect(event).toMatchObject({
        room: null,
        visibilityChannel: { id: channel },
        externalLocation: input.externalLocation,
      });
      await expectStatus(outsider.req("GET", `/v1/meetings/${event.id}`), 404);
      await member.req("POST", `/v1/meetings/${event.id}/respond`, {
        response: "accepted",
        rev: event.rev,
      });
      await expectStatus(
        member.req("PUT", `/v1/meetings/${event.id}`, {
          ...input,
          rev: event.rev,
          scope: "occurrence",
        }),
        403,
      );
      const single = {
        ...input,
        startsAt: startsAt + 1800000,
        endsAt: startsAt + 5400000,
        title: "One special occurrence",
        externalLocation: "Conference hall <literal text>",
        scope: "occurrence",
      };
      event = (
        await owner.req("PUT", `/v1/meetings/${event.id}`, {
          ...single,
          rev: event.rev,
        })
      ).meeting;
      expect(event).toMatchObject({
        title: single.title,
        occurrenceOverride: true,
        externalLocation: single.externalLocation,
        myResponse: null,
      });
      expect(
        (await member.req("GET", `/v1/meetings/${event.id}`)).meeting
          .myResponse,
      ).toBe("pending");
      await expectStatus(
        member.req("POST", `/v1/meetings/${event.id}/respond`, {
          response: "declined",
          rev: event.rev - 1,
        }),
        409,
      );
      await member.req("POST", `/v1/meetings/${event.id}/respond`, {
        response: "declined",
        rev: event.rev,
      });
      await expectStatus(
        owner.req("PUT", `/v1/meetings/${event.id}`, {
          ...single,
          repeat: "monthly",
          rev: event.rev,
        }),
        400,
      );
      const counts = await Promise.all([
        h.ctx.meetings.rollRepeating(single.endsAt + 1),
        h.ctx.meetings.rollRepeating(single.endsAt + 1),
      ]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      event = (await owner.req("GET", `/v1/meetings/${event.id}`)).meeting;
      expect(event).toMatchObject({
        title: input.title,
        startsAt: nextEventStart(startsAt, "weekly", input.timeZone),
        externalLocation: input.externalLocation,
        occurrenceOverride: false,
      });
      expect(
        (await member.req("GET", `/v1/meetings/${event.id}`)).meeting
          .myResponse,
      ).toBe("accepted");
      await owner.req("POST", `/v1/meetings/${event.id}/cancel`, {
        scope: "occurrence",
        rev: event.rev,
      });
      expect(
        (await member.req("GET", `/v1/meetings/${event.id}`)).meeting.cancelled,
      ).toBe(true);
      await expectStatus(
        member.req("POST", `/v1/meetings/${event.id}/respond`, {
          response: "tentative",
        }),
        409,
      );
      expect(await h.ctx.meetings.rollRepeating(event.endsAt + 1)).toBe(1);
      event = (await owner.req("GET", `/v1/meetings/${event.id}`)).meeting;
      expect(event.cancelled).toBe(false);
      event = (
        await owner.req("PUT", `/v1/meetings/${event.id}`, {
          ...input,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          title: "Series name",
          scope: "series",
          rev: event.rev,
        })
      ).meeting;
      expect(await h.ctx.meetings.rollRepeating(event.endsAt + 1)).toBe(1);
      event = (await owner.req("GET", `/v1/meetings/${event.id}`)).meeting;
      expect(event.title).toBe("Series name");
      await owner.req("PUT", `/v1/conversations/${channel}/overwrites`, {
        subject: `user:${member.userId}`,
        allow: [],
        deny: ["channels.view"],
      });
      await expectStatus(member.req("GET", `/v1/meetings/${event.id}`), 404);
      await owner.req("POST", `/v1/meetings/${event.id}/cancel`, {
        scope: "series",
        rev: event.rev,
      });
      expect(await h.ctx.meetings.rollRepeating(event.endsAt + 1)).toBe(0);
    });
  });
