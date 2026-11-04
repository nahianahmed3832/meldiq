import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { expectStatus, startServer, type Harness } from "./support/harness.js";
for (const backend of process.env.MELDIQ_TEST_PG_URL
  ? ["postgres"]
  : ["sqlite", "mongodb"])
  describe(`validated role icons (${backend})`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startServer({
        MONGODB_DOMAINS:
          backend === "mongodb" ? "workspace,conversations,files,calls" : "",
      });
    });
    afterAll(async () => h?.close());
    it("uses same-community available emoji, rejects unauthorized/foreign assets and falls back after removal", async () => {
      const owner = await h.client("iconowner"),
        member = await h.client("iconmember"),
        outsider = await h.client("iconoutsider");
      const org = (
        await owner.req("POST", "/v1/orgs", { name: "Icon fixture" })
      ).org.id;
      const other = (
        await owner.req("POST", "/v1/orgs", { name: "Other fixture" })
      ).org.id;
      const code = (
        await owner.req("POST", `/v1/orgs/${org}/invites`, { role: "MEMBER" })
      ).invite.code;
      await member.req("POST", "/v1/invites/accept", { code });
      const png = await sharp({
        create: { width: 20, height: 20, channels: 3, background: "#a3e635" },
      })
        .png()
        .toBuffer();
      const upload = async (id: string, kind = "emoji") =>
        (
          await owner.req(
            "POST",
            `/v1/orgs/${id}/expressions?kind=${kind}&name=lime`,
            undefined,
            png,
          )
        ).expression;
      const icon = await upload(org),
        foreign = await upload(other),
        sticker = await upload(org, "sticker");
      const role = (
        await owner.req("POST", `/v1/orgs/${org}/roles`, {
          name: "Asset role",
          permissions: [],
        })
      ).role;
      await owner.req("PUT", `/v1/roles/${role.id}/members/${member.userId}`);
      const path = `/v1/roles/${role.id}/extras`;
      await expectStatus(
        member.req("PUT", path, { iconExpressionId: icon.id }),
        403,
      );
      await expectStatus(
        outsider.req("PUT", path, { iconExpressionId: icon.id }),
        404,
      );
      for (const id of [foreign.id, sticker.id, "missing"])
        await expectStatus(
          owner.req("PUT", path, { iconExpressionId: id }),
          400,
        );
      expect(
        (await owner.req("PUT", path, { iconExpressionId: icon.id })).extras
          .iconExpressionId,
      ).toBe(icon.id);
      // Older clients changing a different extra preserve the selected icon.
      expect(
        (await owner.req("PUT", path, { mentionable: true })).extras
          .iconExpressionId,
      ).toBe(icon.id);
      const directory = async () =>
        (await member.req("GET", `/v1/orgs/${org}/members`)).members.find(
          (m: any) => m.id === member.userId,
        ).customRoles[0];
      expect((await directory()).iconExpression).toMatchObject({
        id: icon.id,
        orgId: org,
        sha256: icon.sha256,
      });
      await expectStatus(
        outsider.req("GET", `/v1/expressions/${icon.id}/image`),
        404,
      );
      await owner.req("DELETE", `/v1/expressions/${icon.id}`);
      expect(await directory()).not.toHaveProperty("iconExpression");
      expect(
        (await owner.req("GET", `/v1/orgs/${org}/roles`)).roles.find(
          (r: any) => r.id === role.id,
        ).extras.iconExpressionId,
      ).toBeUndefined();
    });
  });
