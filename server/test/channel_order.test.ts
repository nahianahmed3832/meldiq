import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

/**
 * API 0.48.0 (brief v4 §15): each channel carries its category's place (categoryPosition), so an app orders categories
 * from its first paint, before it has loaded the community's category list, instead of alphabetically and then again.
 */
let h: Harness;
let owner: GriipClient;
let orgId: string;

beforeAll(async () => {
  h = await startServer();
  owner = await h.client("owner");
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Order Lab" })).org.id;
});
afterAll(async () => h.close());

describe("channel order in the conversation list", () => {
  it("gives every channel its category's position, in the order the categories were made; none outside a category", async () => {
    const made: string[] = [];
    for (const name of ["Welcome", "Projects", "Archive"]) {
      const categoryId = (await owner.req("POST", `/v1/orgs/${orgId}/categories`, { name })).category.id as string;
      made.push(categoryId);
      await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: `${name.toLowerCase()}-room`, scope: "ORG", kind: "PUBLIC", categoryId });
    }
    const loose = (await owner.req("POST", `/v1/orgs/${orgId}/channels`, { name: "loose", scope: "ORG", kind: "PUBLIC" })).channel.id;
    const list = (await owner.req("GET", "/v1/conversations")).conversations as { id: string; categoryId: string | null; categoryPosition?: number | null }[];
    const position = (categoryId: string) => list.find((c) => c.categoryId === categoryId)?.categoryPosition;
    const positions = made.map(position);
    expect(positions.every((p) => typeof p === "number")).toBe(true);
    expect([...positions].sort((a, b) => a! - b!)).toEqual(positions);
    expect(new Set(positions).size).toBe(3);
    expect(list.find((c) => c.id === loose)?.categoryPosition).toBeNull();
    // The category list agrees.
    const cats = (await owner.req("GET", `/v1/orgs/${orgId}/categories`)).categories as { id: string; position: number }[];
    for (const id of made) expect(cats.find((c) => c.id === id)?.position).toBe(position(id));
  });
});
