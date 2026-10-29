import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BotDirectoryPage } from "../src/shared/contracts/http/botDirectory.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * The community bot directory (community parity batch E, feature "bot-directory", docs/COMMUNITY_PARITY_API.md ›
 * Discovery): owners list public bots with a category and description; everyone browses, searches (slash commands
 * too) and sorts by most used, newest or A to Z. Runs with bots in memory and the listings in SQLite, and with both in
 * MongoDB.
 */

const WORKSPACE_IN_MONGO = "preferences,reports,relationships,history,accounts,files,relay,billing,workspace,conversations,calls";
const STARTUP_MS = 120_000;
const code = (e: { error: { code: string } }) => e.error.code;

describe.each([
  ["sqlite", {}],
  ["mongodb", { MONGODB_DOMAINS: WORKSPACE_IN_MONGO }],
] as const)("bot directory with communities in %s", (_backend, env) => {
  let h: Harness;
  let dev1: GriipClient, dev2: GriipClient, admin: GriipClient, browser: GriipClient;
  let mod: string, dice: string, secret: string;
  const names = async (query = "") => {
    const page = await browser.req("GET", `/v1/bot-directory${query}`);
    expect(BotDirectoryPage.safeParse(page).success).toBe(true);
    return page.bots.map((b: { displayName: string }) => b.displayName);
  };
  const list = (c: GriipClient, id: string, body: Record<string, unknown>) => c.req("PUT", `/v2/developer/bots/${id}/listing`, body);

  beforeAll(async () => {
    h = await startServer({ ...env });
    [dev1, dev2, admin, browser] = await Promise.all(["bddev1", "bddev2", "bdadmin", "bdbrowser"].map((x) => h.client(x)));
    mod = (await dev1.req("POST", "/v2/developer/bots", { name: "Mod Helper", public: true })).bot.id;
    secret = (await dev1.req("POST", "/v2/developer/bots", { name: "Secret Bot" })).bot.id;
    const made = await dev2.req("POST", "/v2/developer/bots", { name: "Dice Roller", public: true });
    dice = made.bot.id;
    const res = await fetch(`${h.baseUrl}/v2/bot/commands`, {
      method: "PUT",
      headers: { authorization: `Bot ${made.token}`, "content-type": "application/json" },
      body: JSON.stringify({ commands: [{ name: "roll", description: "Roll some dice" }] }),
    });
    expect(res.status).toBe(200);
    const orgs = await Promise.all(["Bot Lab One", "Bot Lab Two"].map(async (name) => (await admin.req("POST", "/v1/orgs", { name })).org.id as string));
    for (const org of orgs) await admin.req("POST", `/v1/orgs/${org}/bots`, { botId: mod });
    await admin.req("POST", `/v1/orgs/${orgs[0]}/bots`, { botId: dice });
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("starts unlisted; only the owner sees and changes a listing, and only public bots can be listed", async () => {
    expect((await browser.req("GET", "/v1/server-info")).features).toContain("bot-directory");
    expect(await dev1.req("GET", `/v2/developer/bots/${mod}/listing`)).toEqual({ listing: { listed: false, category: "other", description: "", listedAt: null, updatedAt: null, public: true } });
    expect(code(await expectStatus(dev2.req("GET", `/v2/developer/bots/${mod}/listing`), 404))).toBe("not_found");
    expect(code(await expectStatus(list(dev1, secret, { listed: true, category: "fun", description: "Hush" }), 409))).toBe("bot_private");
    expect(code(await expectStatus(list(dev1, mod, { listed: true, category: "nope", description: "x" }), 400))).toBe("bad_request");
    expect(code(await expectStatus(list(dev1, mod, { listed: true, category: "fun", description: "x".repeat(201) }), 400))).toBe("bad_request");
    expect(await names()).toEqual([]);
  });

  it("lists bots with install counts and slash commands, sorted and filtered", async () => {
    const { listing } = await list(dev1, mod, { listed: true, category: "moderation", description: "Keeps chat tidy" });
    expect(listing).toMatchObject({ listed: true, category: "moderation", listedAt: expect.any(Number) });
    await new Promise((r) => setTimeout(r, 5));
    await list(dev2, dice, { listed: true, category: "games", description: "Rolls dice for game night" });
    const page = await browser.req("GET", "/v1/bot-directory");
    expect(page.bots[0]).toMatchObject({ id: mod, displayName: "Mod Helper", installCount: 2, category: "moderation", commands: [], owner: { id: dev1.userId } });
    expect(page.bots[1]).toMatchObject({ id: dice, installCount: 1, commands: [{ name: "roll", description: "Roll some dice" }] });
    expect(await names("?sort=a_z")).toEqual(["Dice Roller", "Mod Helper"]);
    expect(await names("?sort=newest")).toEqual(["Dice Roller", "Mod Helper"]);
    expect(await names("?category=games")).toEqual(["Dice Roller"]);
    expect(await names("?q=roll")).toEqual(["Dice Roller"]);
    expect(await names("?q=TIDY")).toEqual(["Mod Helper"]);
    expect(code(await expectStatus(browser.req("GET", "/v1/bot-directory?sort=random"), 400))).toBe("bad_request");
  });

  it("drops bots that are unlisted or made private, keeping when they were first listed", async () => {
    const first = (await dev1.req("GET", `/v2/developer/bots/${mod}/listing`)).listing.listedAt;
    await list(dev1, mod, { listed: false, category: "moderation", description: "Keeps chat tidy" });
    expect(await names()).toEqual(["Dice Roller"]);
    expect((await list(dev1, mod, { listed: true, category: "utility", description: "Keeps chat tidy" })).listing.listedAt).toBe(first);
    await dev2.req("PATCH", `/v2/developer/bots/${dice}`, { public: false });
    expect(await names()).toEqual(["Mod Helper"]);
    expect(h.ctx.ws.count("audit_log", { action: "bot.listing" })).toBe(4);
  });
});

describe("bot directory switched off", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer({ BOT_DIRECTORY: "off" });
  }, STARTUP_MS);
  afterAll(async () => h?.close());

  it("answers 503 and hides the feature", async () => {
    const c = await h.client("bdoff");
    expect((await c.req("GET", "/v1/server-info")).features).not.toContain("bot-directory");
    expect(code(await expectStatus(c.req("GET", "/v1/bot-directory"), 503))).toBe("feature_disabled");
  });
});
