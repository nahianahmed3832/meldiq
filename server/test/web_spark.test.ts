import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { expectStatus, startServer } from "./support/harness.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const root = "/v2/me/spark";
const key = () => randomBytes(32).toString("hex");

it("reports unconfigured status and does not accept prompts when disabled", async () => {
  vi.stubEnv("MELDIQ_SPARK_ENDPOINT", "");
  const h = await startServer({ PLATFORM_SECRETS_KEY: key() });
  try {
    const alice = await h.client("sparkoff");
    expect(await alice.req("GET", root)).toEqual({ configured: false, historyAvailable: true, threads: [] });
    expect((await expectStatus(alice.req("POST", `${root}/threads`, { id: randomUUID(), title: "test" }), 503)).error.code).toBe("provider_not_configured");
  } finally {
    await h.close();
  }
});

it("streams a consented reply, persists it sealed, and never exposes another account's Spark data", async () => {
  const endpoint = "https://gateway.invalid/spark";
  vi.stubEnv("MELDIQ_SPARK_ENDPOINT", endpoint);
  vi.stubEnv("MELDIQ_SPARK_TOKEN", "gateway-token");
  const fetchReal = globalThis.fetch;
  const called: unknown[] = [];
  let broken = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== endpoint) return fetchReal(input, init);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer gateway-token");
    expect(init?.redirect).toBe("error");
    called.push(JSON.parse(init?.body as string));
    return new Response(broken ? '{"delta":"partial"}\n' : '{"delta":"**হ্যালো**"}\n{"delta":" World"}\n{"done":true}\n', {
      headers: { "content-type": "application/x-ndjson" },
    });
  });
  const h = await startServer({ PLATFORM_SECRETS_KEY: key() });
  try {
    const [alice, bob] = await Promise.all([h.client("sparkalice"), h.client("sparkbob")]);
    expect((await fetch(h.baseUrl + root)).status).toBe(401);
    expect((await alice.req("GET", root)).configured).toBe(true);
    const id = randomUUID();
    const path = `${root}/threads/${id}`;
    await alice.req("POST", `${root}/threads`, { id, title: "My private title" });
    await expectStatus(bob.req("GET", path), 404);
    await expectStatus(bob.req("PATCH", path, { title: "Hijack" }), 404);
    await bob.req("DELETE", path);
    const requestId = randomUUID();
    const turn = { requestId, prompt: "How do channels work?", locale: "bn" };
    await expectStatus(alice.req("POST", path + "/turns", { ...turn, consent: false }), 400);
    await expectStatus(bob.req("POST", path + "/turns", { ...turn, consent: true }), 404);
    expect(called).toHaveLength(0);
    const send = async (body: object) => {
      const res = await fetch(h.baseUrl + path + "/turns", {
        method: "POST", body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      return (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    };
    expect(await send({ ...turn, consent: true })).toEqual([
      { type: "delta", text: "**হ্যালো**" }, { type: "delta", text: " World" }, { type: "done" },
    ]);
    expect(called).toHaveLength(1);
    expect(called[0]).toMatchObject({ messages: [{ role: "system" }, { role: "user", content: turn.prompt }] });
    expect(JSON.stringify(called[0])).not.toContain("My private title");
    expect(await send({ ...turn, consent: true })).toHaveLength(2);
    expect(called).toHaveLength(1);
    const sealed = h.ctx.safety.get<{ sealed: string }>("spark_threads", { id })?.sealed;
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(turn.prompt);
    expect((await alice.req("GET", path)).thread.turns).toMatchObject([{ requestId, user: turn.prompt, assistant: "**হ্যালো** World" }]);
    expect((await bob.req("GET", root)).threads).toEqual([]);
    await alice.req("PATCH", path, { title: "New name" });
    expect((await alice.req("GET", root)).threads).toMatchObject([{ id, title: "New name" }]);
    broken = true;
    expect(await send({ ...turn, requestId: randomUUID(), consent: true })).toEqual([
      { type: "delta", text: "partial" }, { type: "error", code: "provider_unavailable" },
    ]);
    expect((await alice.req("GET", path)).thread.turns).toHaveLength(1);
    await alice.req("DELETE", path);
    await expectStatus(alice.req("GET", path), 404);
  } finally {
    await h.close();
  }
});
