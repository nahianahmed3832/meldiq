import { describe, expect, it } from "vitest";
import { cleanName, DiscordChannel, DiscordGuild, emojiName, isPrivate, managesGuild, mapPermissions, planImport } from "../src/modules/organizations/discord/mapping.js";
import { channelsJson, GUILD, guildJson } from "./support/fakeDiscord.js";

/** How a Discord server's structure maps to Meldiq (docs/DISCORD_IMPORT.md): pure rules, no Discord or database. */
const guild = DiscordGuild.parse(guildJson);
const channels = channelsJson.map((c) => DiscordChannel.parse(c));
const LIMITS = { channelsPerCategory: 50, channels: 500, roles: 50, emoji: 50 };
const ALL = { icon: true, roles: true, rolePermissions: true, channels: true, emojis: true };

describe("who may import", () => {
  it("is the owner, or someone with Manage Server or Administrator", () => {
    expect(managesGuild(true, "0")).toBe(true);
    expect(managesGuild(false, String(1n << 5n))).toBe(true);
    expect(managesGuild(false, String(1n << 3n))).toBe(true);
    expect(managesGuild(false, String(1n << 10n))).toBe(false);
    expect(managesGuild(false, "not a number")).toBe(false);
  });
});

describe("role permissions", () => {
  it("maps the powers Meldiq has, and never Administrator", () => {
    expect(mapPermissions(String((1n << 4n) | (1n << 28n))).permissions.sort()).toEqual(["channels.create", "channels.manage", "roles.assign", "roles.manage"]);
    expect(mapPermissions(String(1n << 3n))).toEqual({ permissions: [], notCopied: ["Administrator"] });
    expect(mapPermissions("0").permissions).toEqual([]);
  });
});

describe("names", () => {
  it("keeps channel names readable and within Meldiq's limits", () => {
    expect(cleanName("  general\u0000  ", "channel")).toBe("general");
    expect(cleanName("", "channel")).toBe("channel");
    expect(cleanName("x".repeat(100), "channel")).toHaveLength(60);
  });

  it("makes emoji names Meldiq accepts, or none", () => {
    expect(emojiName("Wave-Hi")).toBe("wave_hi");
    expect(emojiName("ok")).toBe("ok");
    expect(emojiName("😀")).toBeNull();
    expect(emojiName("a")).toBeNull();
  });
});

describe("the plan", () => {
  const plan = planImport(guild, channels, ALL, LIMITS);
  const keys = plan.map((i) => i.sourceKey);

  it("goes icon, roles (highest first), categories, channels, emoji", () => {
    expect(keys[0]).toBe(`icon:${GUILD}`);
    expect(keys.slice(1, 4)).toEqual(["role:300000000000000002", "role:300000000000000001", "role:300000000000000003"]);
    expect(keys.indexOf("category:500000000000000001")).toBeLessThan(keys.indexOf("channel:500000000000000011"));
    expect(keys.at(-1)).toBe("emoji:400000000000000003");
  });

  it("keeps hidden channels private and never makes @everyone or bot roles", () => {
    expect(isPrivate(GUILD, channels.find((c) => c.name === "staff-only")!)).toBe(true);
    expect(isPrivate(GUILD, channels.find((c) => c.name === "general")!)).toBe(false);
    expect(keys).not.toContain(`role:${GUILD}`);
    expect(plan.find((i) => i.sourceKey === "role:300000000000000003")!.spec).toBeNull();
  });

  it("stays within the limits, saying what was left out", () => {
    const tight = planImport(guild, channels, ALL, { channelsPerCategory: 2, channels: 3, roles: 1, emoji: 1 });
    const made = (kind: string) => tight.filter((i) => i.kind === kind && i.spec).length;
    expect(made("role")).toBe(1);
    expect(made("emoji")).toBe(1);
    expect(made("channel")).toBe(3);
    expect(tight.filter((i) => i.kind === "channel" && !i.spec).every((i) => i.note)).toBe(true);
  });

  it("includes only the parts chosen", () => {
    const only = planImport(guild, channels, { icon: false, roles: false, rolePermissions: false, channels: false, emojis: true }, LIMITS);
    expect(new Set(only.map((i) => i.kind))).toEqual(new Set(["emoji"]));
  });
});
