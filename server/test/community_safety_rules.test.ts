import { describe, expect, it } from "vitest";
import { accountAllowedAt, ACCOUNT_AGE_MS, LOCK_MS, RAID_LIMITS, RaidDetector, verificationRefusal } from "../src/modules/organizations/safety/rules.js";
import { voiceActionAllowed } from "../src/modules/organizations/safety/voiceRoutes.js";
import { BASE_ROLE_PERMISSIONS, ROLE_TEMPLATES } from "../src/modules/organizations/permissions/catalog.js";

/**
 * Community safety's pure rules (community parity A2, docs/COMMUNITY_SAFETY_API.md): raid protection's windows on an
 * injected clock, what each verification level asks, the account-age gate and who may mute or disconnect whom.
 */

const MIN = 60_000;
const T0 = 1_800_000_000_000;

describe("raid protection's counting", () => {
  it("locks on 60 joins within a minute, and not on 60 spread over longer", () => {
    const r = new RaidDetector();
    for (let i = 0; i < RAID_LIMITS.joins - 1; i++) expect(r.join("o1", T0 + i * 900)).toBe(false);
    expect(r.join("o1", T0 + 59 * 900)).toBe(true);
    // The window starts over after a flood.
    expect(r.join("o1", T0 + 59 * 900 + 1)).toBe(false);
    const slow = new RaidDetector();
    const spread = Array.from({ length: 120 }, (_, i) => slow.join("o2", T0 + i * 1_100));
    expect(spread.some(Boolean)).toBe(false);
  });

  it("slows a channel on 30 messages from 6 people within 10 seconds, not from fewer people", () => {
    const r = new RaidDetector();
    const people = ["a", "b", "c", "d", "e", "f"];
    const hits = Array.from({ length: 30 }, (_, i) => r.post("c1", people[i % 6]!, T0 + i * 300));
    expect(hits.slice(0, 29).some(Boolean)).toBe(false);
    expect(hits[29]).toBe(true);
    const few = new RaidDetector();
    const fewHits = Array.from({ length: 60 }, (_, i) => few.post("c2", people[i % 5]!, T0 + i * 100));
    expect(fewHits.some(Boolean)).toBe(false);
    // 30 messages from 6 people over more than 10 seconds aren't a flood either.
    const spread = new RaidDetector();
    expect(Array.from({ length: 60 }, (_, i) => spread.post("c3", people[i % 6]!, T0 + i * 400)).some(Boolean)).toBe(false);
  });

  it("takes other thresholds, as the integration tests use", () => {
    const r = new RaidDetector({ ...RAID_LIMITS, joins: 3 });
    expect([r.join("o", T0), r.join("o", T0 + 1), r.join("o", T0 + 2)]).toEqual([false, false, true]);
  });
});

describe("verification levels", () => {
  const fresh = { emailVerified: true, accountCreatedAt: T0, joinedAt: T0 };

  it("asks nothing at none, a verified email from low up", () => {
    expect(verificationRefusal("none", { ...fresh, emailVerified: false }, T0)).toBeNull();
    expect(verificationRefusal("low", { ...fresh, emailVerified: false }, T0)).toEqual({ reason: "email", allowedAt: null });
    expect(verificationRefusal("low", fresh, T0)).toBeNull();
    expect(verificationRefusal("high", { ...fresh, emailVerified: false }, T0 + 60 * MIN)).toEqual({ reason: "email", allowedAt: null });
  });

  it("medium: account and membership 5 minutes old; high: membership 10 minutes", () => {
    expect(verificationRefusal("medium", fresh, T0 + MIN)).toEqual({ reason: "wait", allowedAt: T0 + 5 * MIN });
    expect(verificationRefusal("medium", { ...fresh, accountCreatedAt: T0 - 60 * MIN }, T0 + MIN)).toEqual({ reason: "wait", allowedAt: T0 + 5 * MIN });
    expect(verificationRefusal("medium", { ...fresh, joinedAt: T0 - 60 * MIN }, T0 + 2 * MIN)).toEqual({ reason: "wait", allowedAt: T0 + 5 * MIN });
    expect(verificationRefusal("medium", fresh, T0 + 5 * MIN)).toBeNull();
    expect(verificationRefusal("high", fresh, T0 + 6 * MIN)).toEqual({ reason: "wait", allowedAt: T0 + 10 * MIN });
    expect(verificationRefusal("high", fresh, T0 + 10 * MIN)).toBeNull();
  });
});

describe("account-age gate and lock lengths", () => {
  it("lets older accounts in and says when a young one may join", () => {
    expect(accountAllowedAt("off", T0, T0)).toBeNull();
    expect(accountAllowedAt("10m", T0, T0 + MIN)).toBe(T0 + 10 * MIN);
    expect(accountAllowedAt("1h", T0, T0 + 61 * MIN)).toBeNull();
    expect(accountAllowedAt("7d", T0, T0 + ACCOUNT_AGE_MS["1d"])).toBe(T0 + ACCOUNT_AGE_MS["7d"]);
    expect(Object.values(LOCK_MS)).toEqual([15 * MIN, 60 * MIN, 8 * 60 * MIN, 24 * 60 * MIN]);
  });
});

describe("voice moderation keys", () => {
  const moderator = ROLE_TEMPLATES.find((t) => t.key === "moderator")!;
  const modActor = { base: "MEMBER" as const, perms: new Set([...BASE_ROLE_PERMISSIONS.MEMBER, ...moderator.permissions]) };

  it("are admin powers in the moderator template", () => {
    expect(moderator.permissions).toEqual(expect.arrayContaining(["voice.mute_members", "voice.move_members"]));
    expect(BASE_ROLE_PERMISSIONS.ADMIN.has("voice.mute_members")).toBe(true);
    expect(BASE_ROLE_PERMISSIONS.MEMBER.has("voice.move_members")).toBe(false);
  });

  it("act on members and guests below the holder, never on owners", () => {
    expect(voiceActionAllowed(modActor, "MEMBER", "voice.mute_members", BASE_ROLE_PERMISSIONS.MEMBER)).toBe(true);
    expect(voiceActionAllowed(modActor, "GUEST", "voice.move_members", BASE_ROLE_PERMISSIONS.GUEST)).toBe(true);
    expect(voiceActionAllowed(modActor, "ADMIN", "voice.mute_members", BASE_ROLE_PERMISSIONS.ADMIN)).toBe(false);
    expect(voiceActionAllowed({ base: "OWNER", perms: BASE_ROLE_PERMISSIONS.OWNER }, "OWNER", "voice.mute_members", BASE_ROLE_PERMISSIONS.OWNER)).toBe(false);
    expect(voiceActionAllowed({ base: "OWNER", perms: BASE_ROLE_PERMISSIONS.OWNER }, "ADMIN", "voice.mute_members", BASE_ROLE_PERMISSIONS.ADMIN)).toBe(true);
    // Someone holding powers the actor lacks (here: workspace.edit) is out of reach.
    expect(voiceActionAllowed(modActor, "MEMBER", "voice.mute_members", new Set([...BASE_ROLE_PERMISSIONS.MEMBER, "workspace.edit" as const]))).toBe(false);
    expect(voiceActionAllowed({ base: "MEMBER", perms: BASE_ROLE_PERMISSIONS.MEMBER }, "MEMBER", "voice.mute_members", BASE_ROLE_PERMISSIONS.MEMBER)).toBe(false);
  });
});
