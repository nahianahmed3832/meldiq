import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type {MessageEvent} from "../src/modules/messaging/store/messageStore.js";
import {CollectionResponse} from "../src/shared/contracts/http/messageCollections.js";
import {startServer, expectStatus, type Harness} from "./support/harness.js";
import type {GriipClient} from "./support/griipClient.js";

const backends = process.env.MELDIQ_TEST_PG_URL ? ["postgres"] : ["sqlite", "mongodb"];
for (const backend of backends) describe(`authoritative message collections (${backend})`, () => {
  let h: Harness, alice: GriipClient, bob: GriipClient, outsider: GriipClient, conversation: string;
  const ids = (page: any) => page.messages.map((message: {id: string}) => message.id);
  const get = async (query: string, person = alice) => {
    const page = await person.req("GET", `/v2/conversations/${conversation}/message-collections?${query}`);
    expect(CollectionResponse.safeParse(page).success).toBe(true);
    return page;
  };
  beforeAll(async () => {
    h = await startServer({MONGODB_DOMAINS: backend === "mongodb" ? "history" : ""});
    alice = await h.client("collectionsalice"); bob = await h.client("collectionsbob"); outsider = await h.client("collectionsoutsider");
    conversation = (await alice.req("POST", "/v1/conversations/dm", {userId: bob.userId})).conversation.id;
    const event = (id: string, payload: unknown, fields: Partial<MessageEvent> = {}): MessageEvent => ({id, conversation_id: conversation,
      sender_user_id: bob.userId, sender_device_id: null, cls: "message", type: "text", target: null, audience: "all",
      payload: typeof payload === "string" ? payload : JSON.stringify(payload), sent_at: 1000, server_ts: 1000, mention_all: 0, imported_by: "synthetic-fixture", ...fields});
    const text = (extra = {}) => ({type: "text", text: "Synthetic collection fixture", ...extra});
    const attachment = (mime: string, voice = false) => text({attachments: [{id: "synthetic-file", mime, voice}]});
    await h.ctx.messages.addMany([
      event("root_0001", text()), event("root_0002", text()),
      event("reply_001", text({threadRoot: "root_0001"})), event("reply_002", text({threadRoot: "root_0002"})),
      event("media_001", attachment("IMAGE/PNG")), event("media_002", attachment("video/mp4")),
      event("files_001", attachment("application/pdf")), event("voice_001", attachment("audio/ogg", true)),
      event("gone_media", attachment("image/jpeg")), event("self_0001", attachment("image/png"), {audience: "self"}),
      event("self_reply", text({threadRoot: "root_0001"}), {audience: "self"}),
      event("bad_json1", "broken historical payload"), event("bad_json2", "[]"), event("bad_json3", '"string"'),
      event("delete_01", {type: "delete", target: "gone_media"}, {cls: "control", type: "delete", target: "gone_media"}),
      event("pin_00001", {type: "pin", target: "media_001", pinned: true}, {cls: "control", type: "pin", target: "media_001"}),
      event("pin_00002", {type: "pin", target: "root_0001", pinned: true}, {cls: "control", type: "pin", target: "root_0001"}),
      event("pin_00003", {type: "pin", target: "root_0001", pinned: false}, {cls: "control", type: "pin", target: "root_0001"}),
      event("pin_00004", {type: "pin", target: "root_0002", pinned: true}, {cls: "control", type: "pin", target: "root_0002", audience: "self"}),
    ]);
  });
  afterAll(async () => h?.close());
  it("classifies media/files and excludes deleted, voice, malformed and someone else's private content", async () => {
    expect(ids(await get("kind=media"))).toEqual(["media_002", "media_001"]);
    expect(ids(await get("kind=files"))).toEqual(["files_001"]);
    expect(ids(await get("kind=media", bob))).toContain("self_0001");
  });
  it("uses the latest visible pin state, including deterministic equal-timestamp ordering", async () => {
    expect(ids(await get("kind=pins"))).toEqual(["media_001"]);
    expect(ids(await get("kind=pins", bob))).toEqual(["root_0002", "media_001"]);
  });
  it("paginates every main timeline timestamp tie once without returning replies or malformed payloads", async () => {
    const found: string[] = [];
    let query = "kind=main&limit=2";
    for (let i = 0; i < 10; i++) {
      const page = await get(query); found.push(...ids(page));
      if (!page.more) {expect(page.nextCursor).toBeNull(); break;}
      query = `kind=main&limit=2&before=${page.nextCursor.serverTs}&beforeId=${page.nextCursor.id}`;
    }
    expect(found).toEqual(["voice_001", "root_0002", "root_0001", "media_002", "media_001", "gone_media", "files_001"]);
    expect(new Set(found).size).toBe(found.length);
  });
  it("paginates thread summaries by time and root ID with private replies excluded from counts", async () => {
    const first = await get("kind=threads&limit=1");
    expect(first.threads).toEqual([{rootId: "root_0002", replyCount: 1, lastReplyTs: 1000}]);
    const next = await get(`kind=threads&limit=1&before=${first.nextCursor.serverTs}&beforeId=${first.nextCursor.id}`);
    expect(next.threads).toEqual([{rootId: "root_0001", replyCount: 1, lastReplyTs: 1000}]);
    expect(ids(next)).toEqual(["root_0001"]); expect(next.more).toBe(false);
  });
  it("returns thread context and rejects an around anchor from another thread or private audience", async () => {
    const page = await get("kind=thread&root=root_0001&around=reply_001");
    expect(ids(page)).toEqual(["reply_001"]); expect(page.context.map((item: {id: string}) => item.id)).toEqual(["root_0001"]);
    await expectStatus(get("kind=thread&root=root_0001&around=reply_002"), 404);
    await expectStatus(get("kind=main&around=self_0001"), 404);
  });
  it("keeps deleted main anchors as tombstones with their authorized controls and denies outsiders", async () => {
    const page = await get("kind=main&around=gone_media&limit=2");
    expect(ids(page)).toContain("gone_media");
    expect(page.changes.map((item: {id: string}) => item.id)).toContain("delete_01");
    await expectStatus(get("kind=main", outsider), 404);
    expect(h.ctx.postgres?.legacySqlAttempts ?? 0).toBe(0);
  });
});
