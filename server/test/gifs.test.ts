import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowedMediaHost } from "../src/modules/messaging/gifsRoutes.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** API 0.45.0 (docs/GIFS.md): GIF search through the server, against a local stand-in for Tenor's API. */
let tenor: http.Server;
const seen: string[] = [];
let on: Harness, off: Harness;
let ada: GriipClient, bob: GriipClient;

beforeAll(async () => {
  tenor = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    const result = (id: string) => ({
      id,
      content_description: `gif ${id}`,
      media_formats: { tinygif: { url: `https://media.tenor.com/${id}/tiny.gif`, dims: [220, 124] }, gif: { url: `https://media.tenor.com/${id}/full.gif`, dims: [498, 280] } },
    });
    res.setHeader("content-type", "application/json");
    if (url.searchParams.get("key") !== "k-test") return res.writeHead(401).end("{}");
    if (url.pathname.endsWith("/search")) return res.end(JSON.stringify({ results: [result("a1"), result("a2")], next: "p2" }));
    if (url.pathname.endsWith("/featured")) return res.end(JSON.stringify({ results: [result("t1")], next: "" }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => tenor.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(tenor.address() as AddressInfo).port}/v2`;
  on = await startServer({ GIF_PROVIDER: "tenor", GIF_API_KEY: "k-test", GIF_API_BASE: base });
  off = await startServer();
  ada = await on.client("ada");
  bob = await off.client("bob");
});
afterAll(async () => {
  await on.close();
  await off.close();
  tenor.close();
});

describe("GIF search", () => {
  it("says plainly when it isn't set up, and offers nothing that would fail", async () => {
    expect(await bob.req("GET", "/v1/gifs/status")).toEqual({ configured: false, provider: null, attribution: null });
    await expectStatus(bob.req("POST", "/v1/gifs/search", { q: "cat" }), 503);
  });

  it("searches and lists popular GIFs through the server, with the content filter, never logging the words in a URL", async () => {
    expect((await ada.req("GET", "/v1/gifs/status")).configured).toBe(true);
    const page = await ada.req("POST", "/v1/gifs/search", { q: "happy cat" });
    expect(page.results).toHaveLength(2);
    expect(page.results[0]).toMatchObject({ id: "a1", preview: { url: "https://media.tenor.com/a1/tiny.gif", width: 220, height: 124 }, gif: { width: 498 } });
    expect(page.next).toBe("p2");
    expect(seen.at(-1)).toMatch(/contentfilter=medium/);
    expect((await ada.req("POST", "/v1/gifs/trending", {})).results[0].id).toBe("t1");
    await expectStatus(ada.req("POST", "/v1/gifs/search", { q: "" }), 400);
  });

  it("fetches media only from the provider's own hosts", async () => {
    expect(allowedMediaHost("tenor", "media.tenor.com")).toBe(true);
    expect(allowedMediaHost("tenor", "evil.example")).toBe(false);
    expect(allowedMediaHost("giphy", "media2.giphy.com")).toBe(true);
    expect(allowedMediaHost("giphy", "giphy.com.evil.example")).toBe(false);
    for (const src of ["http://media.tenor.com/x.gif", "https://169.254.169.254/latest", "https://user:pw@media.tenor.com/x.gif", "https://media.tenor.com:8443/x.gif", "not a url"]) {
      await expectStatus(ada.req("GET", `/v1/gifs/media?src=${encodeURIComponent(src)}`), 400);
    }
  });
});
