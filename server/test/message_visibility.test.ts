import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

let h: Harness;
beforeAll(async () => { h = await startServer(); });
afterAll(async () => h.close());

it("global search and summaries obey the same current membership denial as direct history", async () => {
  const owner = await h.client("visibilityowner");
  const org = (await owner.req("POST", "/v1/orgs", { name: "Visibility fixture" })).org.id;
  const channel = (await owner.req("POST", `/v1/orgs/${org}/channels`, { name: "private-scope" })).channel.id;
  owner.serverMessages = true;
  await owner.send(channel, { type: "text", text: "visibilityneedle" });
  expect((await owner.req("GET", "/v2/messages/search?q=visibilityneedle")).messages).toHaveLength(1);
  // Suspension is an existing authority hook. Exercise its denial without changing any real community or staff state.
  const suspended = vi.spyOn(h.ctx.authz, "platformSuspended").mockImplementation((id) => id === org);
  try {
    await expectStatus(owner.req("GET", `/v2/conversations/${channel}/messages`), 404);
    await expectStatus(owner.req("GET", `/v2/messages/search?q=visibilityneedle&conversationId=${channel}`), 404);
    expect((await owner.req("GET", "/v2/messages/search?q=visibilityneedle")).messages).toEqual([]);
    expect((await owner.req("GET", "/v2/messages/summary")).conversations.map((c: { conversationId: string }) => c.conversationId)).not.toContain(channel);
  } finally {
    suspended.mockRestore();
  }
});
