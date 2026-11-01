import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../src/app/server.js";
import { dayBefore, dayOf } from "../src/modules/officialBots/wordyGame.js";
import { startServer, type Harness } from "./support/harness.js";

it("processes a persisted Wordy community on its first startup tick after billing is ready", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-bot-startup-"));
  let first: Harness | null = null;
  let restarted: BuiltApp | null = null;
  try {
    first = await startServer({ DATA_DIR: dataDir, MONGODB_URI: "", MONGODB_DOMAINS: "" });
    const owner = await first.client("startupowner");
    const { org } = await owner.req("POST", "/v1/orgs", { name: "Startup bots" });
    const { conversations } = await owner.req("GET", "/v1/conversations");
    const channel = conversations.find((c: { orgId: string; voice: boolean; kind: string; format: string }) => c.orgId === org.id && !c.voice && c.format !== "forum" && c.kind !== "ANNOUNCEMENT");
    await owner.req("PUT", `/v1/orgs/${org.id}/official-bots/wordy`, { enabled: true, settings: { channelId: channel.id } });
    const yesterday = dayBefore(dayOf(Date.now()));
    await first.ctx.officialBots.settled();
    await first.ctx.ws.write((w) => w.delete("bot_wordy_recaps", { org_id: org.id, day: yesterday }));
    const config = first.ctx.config;
    await first.close(); first = null;
    restarted = await buildApp(config, { logger: false });
    await restarted.app.ready();
    await restarted.ctx.officialBots.settled();
    expect(restarted.ctx.ws.get("bot_wordy_recaps", { org_id: org.id, day: yesterday })).toBeDefined();
    expect(restarted.ctx.billing).toBeDefined();
  } finally {
    if (first) await first.close();
    if (restarted) { await restarted.app.close(); restarted.ctx.db.close(); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
