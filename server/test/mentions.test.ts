import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withoutMentionAll } from "../src/modules/messaging/mentions.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

// Group mentions (2026-10-17, docs/MENTIONS.md). Individual mentions travel inside the encrypted payload as user ids;
// @everyone needs the server's attestation, which it gives only where its policy allows.

let h: Harness;
let admin: GriipClient, ann: GriipClient, bob: GriipClient, cat: GriipClient;

beforeAll(async () => {
  // A low limit so "large" groups are easy to build: ordinary members may @everyone only with ≤ 3 members.
  h = await startServer({ MENTION_ALL_MEMBER_LIMIT: "3", MENTION_ALL_PER_HOUR: "2" });
  admin = await h.client("madmin");
  ann = await h.client("mann");
  bob = await h.client("mbob");
  cat = await h.client("mcat");
  for (const c of [admin, ann, bob, cat]) await c.connect();
});
afterAll(async () => h.close());

const group = async (by: GriipClient, members: GriipClient[], name = "Ops") =>
  (await by.req("POST", "/v1/conversations/group", { name, memberIds: members.map((m) => m.userId) })).conversation.id as string;
const text = (body: string, mentions?: string[], mentionAll?: boolean) => ({ type: "text", text: body, ...(mentions ? { mentions } : {}), ...(mentionAll ? { mentionAll } : {}) });

describe("individual mentions", () => {
  it("travel inside the encrypted payload as user ids, unchanged by the server", async () => {
    const g = await group(admin, [ann, bob]);
    await ann.send(g, text(`hi @${bob.username}`, [bob.userId]));
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload.text === `hi @${bob.username}`));
    expect(got.payload.mentions).toEqual([bob.userId]);
    expect(got.mentionAllAttested).toBe(false);
  });
});

describe("@everyone", () => {
  it("a member of a small group may notify everyone; every copy carries the server's mark", async () => {
    const g = await group(ann, [bob, cat]); // 3 members ≤ limit
    expect((await ann.req("GET", `/v1/conversations/${g}`)).conversation.canMentionAll).toBe(true);
    await ann.send(g, text("@everyone lunch", undefined, true), "message", undefined, { mentionAll: true });
    for (const r of [bob, cat]) {
      const m = await r.waitFor(() => r.received.find((x) => x.payload.text === "@everyone lunch"));
      expect(m.mentionAllAttested).toBe(true);
      expect(m.payload.mentionAll).toBe(true);
    }
  });

  it("ordinary members of a larger group are refused; admins are not", async () => {
    const g = await group(admin, [ann, bob, cat]); // 4 members > limit; the creator is the group's admin
    expect((await ann.req("GET", `/v1/conversations/${g}`)).conversation.canMentionAll).toBe(false);
    expect((await admin.req("GET", `/v1/conversations/${g}`)).conversation.canMentionAll).toBe(true);
    const refused = await expectStatus(ann.send(g, text("@everyone spam", undefined, true), "message", undefined, { mentionAll: true }), 403);
    expect(refused.error.code).toBe("mention_all_not_allowed");
    // The refused message wasn't delivered at all.
    await admin.send(g, text("@everyone standup", undefined, true), "message", undefined, { mentionAll: true });
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload.text === "@everyone standup"));
    expect(got.mentionAllAttested).toBe(true);
    expect(bob.received.some((m) => m.payload.text === "@everyone spam")).toBe(false);
  });

  it("a claim inside the payload without the server's mark is just text", async () => {
    const g = await group(admin, [ann, bob, cat]);
    // A modified client sets mentionAll inside the encrypted payload but doesn't ask the server.
    await ann.send(g, text("@everyone sneaky", undefined, true));
    const got = await bob.waitFor(() => bob.received.find((m) => m.payload.text === "@everyone sneaky"));
    expect(got.payload.mentionAll).toBe(true);
    expect(got.mentionAllAttested).toBe(false); // recipients won't treat it as a mention
  });

  it("isn't available in direct messages", async () => {
    const dm = (await ann.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    expect((await ann.req("GET", `/v1/conversations/${dm}`)).conversation.canMentionAll).toBe(false);
    expect((await expectStatus(ann.send(dm, text("@everyone"), "message", undefined, { mentionAll: true }), 403)).error.code).toBe("mention_all_not_in_dm");
  });

  it("is limited per hour, and a retried message isn't counted twice", async () => {
    const g = await group(bob, [cat]);
    const first = crypto.randomUUID();
    await bob.send(g, text("@everyone 1", undefined, true), "message", first, { mentionAll: true });
    // The same message again (an app retry after a lost response): accepted as a duplicate, not counted.
    const again = await bob.send(g, text("@everyone 1", undefined, true), "message", first, { mentionAll: true });
    expect(again.duplicate).toBe(true);
    await bob.send(g, text("@everyone 2", undefined, true), "message", undefined, { mentionAll: true });
    const limited = await expectStatus(bob.send(g, text("@everyone 3", undefined, true), "message", undefined, { mentionAll: true }), 429);
    expect(limited.error.code).toBe("mention_all_rate_limited");
    // Ordinary messages and individual mentions are never limited.
    await bob.send(g, text(`@${cat.username} still fine`, [cat.userId]));
    const rows = { n: h.ctx.ws.count("mention_all_events", { conversation_id: g }) };
    expect(rows.n).toBe(2);
  });

  it("controls (edits, reactions, receipts) never carry the mark", async () => {
    const g = await group(cat, [ann]);
    await cat.send(g, { type: "reaction", target: "x", emoji: "👍", add: true }, "control", undefined, { mentionAll: true });
    const got = await ann.waitFor(() => ann.received.find((m) => m.payload.type === "reaction" && m.conversationId === g));
    expect(got.mentionAllAttested).toBe(false);
  });

  it("a peer server's mark is removed before queueing (federated conversations are direct messages)", () => {
    const remote = JSON.stringify({ v: 1, cls: "message", ciphertext: "abc", mentionAll: true });
    expect(JSON.parse(withoutMentionAll(remote))).toEqual({ v: 1, cls: "message", ciphertext: "abc" });
    const plain = JSON.stringify({ v: 1, cls: "message", ciphertext: "abc" });
    expect(withoutMentionAll(plain)).toBe(plain); // ordinary payloads pass through byte for byte
  });
});
