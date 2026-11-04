import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_CAPABILITIES } from "../src/modules/organizations/permissions/channel.js";
import { permissionDef } from "../src/modules/organizations/permissions/catalog.js";
import { expectStatus, startServer, type Harness } from "./support/harness.js";

describe("every channel capability through authorized API overwrites", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer();
  });
  afterAll(async () => h?.close());
  it("applies inherited deny, multiple roles, personal deny and community restrictions while protecting owners and guest limits", async () => {
    const owner = await h.client("matrixowner"),
      member = await h.client("matrixmember"),
      guest = await h.client("matrixguest"),
      outsider = await h.client("matrixoutside");
    const org = (
      await owner.req("POST", "/v1/orgs", {
        name: "Permission override matrix",
      })
    ).org.id;
    for (const [client, role] of [
      [member, "MEMBER"],
      [guest, "GUEST"],
    ] as const) {
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role })
      ).invite.code;
      await client.req("POST", "/v1/invites/accept", { code });
    }
    const category = (
      await owner.req("POST", `/v1/orgs/${org}/categories`, {
        name: "Inherited policy",
      })
    ).category.id;
    const channel = (
      await owner.req("POST", `/v1/orgs/${org}/channels`, {
        name: "matrix",
        categoryId: category,
        scope: "ORG",
      })
    ).channel.id;
    await owner.req(
      "PUT",
      `/v1/conversations/${channel}/members/${guest.userId}`,
      { role: "MEMBER" },
    );
    const a = (
      await owner.req("POST", `/v1/orgs/${org}/roles`, {
        name: "Matrix grant",
        permissions: [],
      })
    ).role;
    const b = (
      await owner.req("POST", `/v1/orgs/${org}/roles`, {
        name: "Matrix deny",
        permissions: [],
      })
    ).role;
    for (const r of [a, b])
      await owner.req("PUT", `/v1/roles/${r.id}/members/${member.userId}`);
    let overwritePath = `/v1/conversations/${channel}/overwrites`;
    const overwrite = (
      subject: string,
      allow: readonly string[],
      deny: readonly string[],
    ) => owner.req("PUT", overwritePath, { subject, allow, deny });
    const effective = (id: string) =>
      h.ctx.authz.channelPermissions(h.ctx.authz.conversation(channel)!, id);
    await expectStatus(
      outsider.req("PUT", `/v1/conversations/${channel}/overwrites`, {
        subject: "everyone",
        allow: ["messages.post"],
        deny: [],
      }),
      404,
    );
    await expectStatus(
      member.req("PUT", `/v1/conversations/${channel}/overwrites`, {
        subject: "everyone",
        allow: ["messages.post"],
        deny: [],
      }),
      403,
    );
    for (const cap of CHANNEL_CAPABILITIES) {
      overwritePath =
        cap === "channels.create"
          ? `/v1/categories/${category}/overwrites`
          : `/v1/conversations/${channel}/overwrites`;
      await owner.req("PUT", `/v1/categories/${category}/overwrites`, {
        subject: "everyone",
        allow: [],
        deny: [cap],
      });
      await overwrite(a.id, [], []);
      await overwrite(b.id, [], []);
      await overwrite(`user:${member.userId}`, [], []);
      expect(effective(member.userId).has(cap), `${cap}: inherited deny`).toBe(
        false,
      );
      await overwrite(a.id, [cap], []);
      await overwrite(b.id, [], [cap]);
      expect(
        effective(member.userId).has(cap),
        `${cap}: multiple role allow wins at channel level`,
      ).toBe(true);
      await overwrite(`user:${member.userId}`, [], [cap]);
      expect(effective(member.userId).has(cap), `${cap}: personal deny`).toBe(
        false,
      );
      expect(
        effective(owner.userId).has(cap),
        `${cap}: owner can recover`,
      ).toBe(true);
      await overwrite(`user:${guest.userId}`, [cap], []);
      expect(effective(guest.userId).has(cap), `${cap}: guest ceiling`).toBe(
        permissionDef(cap).guestAllowed,
      );
    }
    const restricted = CHANNEL_CAPABILITIES.filter(
      (cap) => permissionDef(cap).restrictable,
    );
    const quiet = (
      await owner.req("POST", `/v1/orgs/${org}/roles`, {
        name: "Community restrictions",
        permissions: [],
        denies: restricted,
      })
    ).role;
    await owner.req("PUT", `/v1/roles/${quiet.id}/members/${member.userId}`);
    await overwrite(
      `user:${member.userId}`,
      restricted.filter((c) => c !== "channels.create"),
      [],
    );
    for (const cap of restricted)
      expect(
        effective(member.userId).has(cap),
        `${cap}: community restriction cannot be lifted by channel`,
      ).toBe(false);
    await expectStatus(
      owner.req("PUT", `/v1/conversations/${channel}/overwrites`, {
        subject: "everyone",
        allow: ["administrator"],
        deny: [],
      }),
      400,
    );
  });
});
