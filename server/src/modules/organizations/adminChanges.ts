import { PERMISSION_KEYS } from "./permissions/catalog.js";
/** Explicit administrative fields only. Callers never pass message, profile, application or report evidence. */
const FIELDS = {
  color: "Color",
  color2: "Second color",
  accent: "Accent color",
  tag: "Community tag",
  visibility: "Visibility",
  join_policy: "Join policy",
  kind: "Channel access",
  scope: "Channel scope",
  category_id: "Category",
  archived_at: "Archived",
  slowmode_sec: "Slowmode seconds",
  voice: "Voice room",
  format: "Channel format",
  permissions: "Permission grants",
  denies: "Permission restrictions",
  allow: "Permission grants",
  deny: "Permission restrictions",
  inherit: "Inherit permissions",
  hoist: "Show role members separately",
  position: "Position",
  mentionable: "Mentionable role",
  auto_assign: "Automatic assignment",
  auto_before: "Joined before",
  icon_expression_id: "Role icon",
  role: "Member access",
  timeout_until: "Timeout ends",
  expires_at: "Expires",
  max_uses: "Maximum uses",
  revoked_at: "Revoked",
  starts_at: "Starts",
  ends_at: "Ends",
  time_zone: "Time zone",
  repeat: "Repeats",
  cancelled_at: "Cancelled",
  cover_id: "Event cover",
  invites_paused_until: "Invitations paused until",
  dms_paused_until: "New direct messages paused until",
} as const;
export type AuditValue = string | number | boolean | null | string[];
export interface AuditChange {
  field: string;
  before: AuditValue;
  after: AuditValue;
}
const arrays = new Set(["permissions", "denies", "allow", "deny"]);
const permissions = new Set<string>(PERMISSION_KEYS);
const enums: Record<string, readonly string[]> = {
  visibility: ["public", "private"],
  join_policy: ["invite", "open", "approval", "application"],
  kind: ["PUBLIC", "PRIVATE", "ANNOUNCEMENT"],
  scope: ["ORG", "BRANCH", "TEAM"],
  format: ["text", "forum"],
  auto_assign: ["none", "everyone", "joined_before"],
  role: ["OWNER", "ADMIN", "MEMBER", "GUEST"],
  repeat: ["weekly", "biweekly", "monthly", "yearly"],
};
function safeValue(field: string, value: unknown): AuditValue | undefined {
  if (value === undefined || value === null) return null;
  if (arrays.has(field)) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return undefined;
      }
    }
    return Array.isArray(value) &&
      value.length <= 64 &&
      value.every((v) => typeof v === "string" && permissions.has(v))
      ? [...new Set(value as string[])].sort()
      : undefined;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z0-9_/#.:-]+$/.test(value)
  )
    return undefined;
  if (enums[field] && !enums[field].includes(value)) return undefined;
  if (
    !enums[field] &&
    ![
      "color",
      "color2",
      "accent",
      "tag",
      "category_id",
      "icon_expression_id",
      "cover_id",
      "time_zone",
    ].includes(field)
  )
    return undefined;
  if (
    ["color", "color2", "accent"].includes(field) &&
    !/^#[\da-f]{6}$/i.test(value)
  )
    return undefined;
  return value;
}
export function auditChanges(before: object, after: object): AuditChange[] {
  const previous = before as Record<string, unknown>,
    next = after as Record<string, unknown>;
  const changes: AuditChange[] = [];
  for (const field of Object.keys(FIELDS)) {
    if (!(field in next)) continue;
    const a = safeValue(field, previous[field]),
      b = safeValue(field, next[field]);
    if (
      a !== undefined &&
      b !== undefined &&
      JSON.stringify(a) !== JSON.stringify(b)
    )
      changes.push({ field, before: a, after: b });
  }
  return changes;
}
/** Revalidate both on persistence and projection; malformed/legacy data is withheld. */
export function safeAuditChanges(input: unknown): AuditChange[] {
  if (!Array.isArray(input) || input.length > 40) return [];
  return input.flatMap((c) => {
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.field !== "string" ||
      !Object.hasOwn(FIELDS, c.field)
    )
      return [];
    const before = safeValue(c.field, c.before),
      after = safeValue(c.field, c.after);
    return before === undefined || after === undefined
      ? []
      : [{ field: c.field, before, after }];
  });
}
export function storedAuditChanges(input: string | null | undefined) {
  let changes: AuditChange[] = [];
  try {
    changes = safeAuditChanges(JSON.parse(input ?? "null"));
  } catch {
    /* Withhold malformed legacy data. */
  }
  return changes.map((c) => ({
    ...c,
    field: FIELDS[c.field as keyof typeof FIELDS],
  }));
}
