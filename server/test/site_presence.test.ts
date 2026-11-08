import { expect, it, vi } from "vitest";
import { startServer } from "./support/harness.js";

it("publishes only an aggregate of connected humans with broadly visible presence", async () => {
  const server = await startServer();
  try {
    const visible = await server.client("publicpresence");
    const restricted = await server.client("restrictedpresence");
    const invisible = await server.client("invisiblepresence");
    const offline = await server.client("offlinepresence");
    for (const account of [visible, invisible, offline]) {
      await account.req("PUT", "/v1/users/me/privacy", { lastSeen: "everyone" });
    }
    await invisible.req("PUT", "/v1/users/me/presence", { mode: "invisible" });
    await Promise.all([visible.connect(), restricted.connect(), invisible.connect()]);
    const result = await server.app.inject({ method: "GET", url: "/v2/site/presence" });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("public, max-age=15");
    expect(result.json()).toEqual({ online: 1 });

    await visible.req("PUT", "/v1/users/me/privacy", { lastSeen: "nobody" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    try {
      const refreshed = await server.app.inject({ method: "GET", url: "/v2/site/presence" });
      expect(refreshed.json()).toEqual({ online: 0 });
    } finally {
      clock.mockRestore();
    }
  } finally {
    await server.close();
  }
});
