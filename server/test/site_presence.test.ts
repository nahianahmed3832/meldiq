import { expect, it, vi } from "vitest";
import { startServer } from "./support/harness.js";

it("counts default and public presence without including opted-out, invisible, or offline accounts", async () => {
  const server = await startServer();
  try {
    const visible = await server.client("publicpresence");
    const defaultPrivacy = await server.client("defaultpresence");
    const hidden = await server.client("hiddenpresence");
    const invisible = await server.client("invisiblepresence");
    const offline = await server.client("offlinepresence");
    for (const account of [visible, invisible, offline]) {
      await account.req("PUT", "/v1/users/me/privacy", { lastSeen: "everyone" });
    }
    await invisible.req("PUT", "/v1/users/me/presence", { mode: "invisible" });
    await hidden.req("PUT", "/v1/users/me/privacy", { lastSeen: "nobody" });
    await Promise.all([visible.connect(), defaultPrivacy.connect(), hidden.connect(), invisible.connect()]);
    const result = await server.app.inject({ method: "GET", url: "/v2/site/presence" });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("public, max-age=15");
    expect(result.json()).toEqual({ online: 2 });

    await visible.req("PUT", "/v1/users/me/privacy", { lastSeen: "nobody" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    try {
      const refreshed = await server.app.inject({ method: "GET", url: "/v2/site/presence" });
      expect(refreshed.json()).toEqual({ online: 1 });
    } finally {
      clock.mockRestore();
    }
  } finally {
    await server.close();
  }
});
