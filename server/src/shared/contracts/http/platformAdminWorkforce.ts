import { z } from "zod/v4";
import { zCount, zTime } from "./primitives.js";
import { zPerson, zReason, zRef } from "./platformAdmin.js";

/**
 * The AI Control Center (docs/AI_WORKFORCE.md): AI Workforce in the Platform Admin Console. Model capabilities and
 * routing, the agent catalog, tool policies, community entitlements, jobs and workers, and emergency controls. Job
 * views carry metadata only: operators see states, counts, durations and error kinds, never briefs, files or output.
 * The console mirrors this file.
 */
const zAiModel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const zCapability = z.enum([
  "text",
  "vision",
  "transcription",
  "speech",
  "image_generation",
  "embeddings",
]);
const zCategory = z.enum([
  "reasoning",
  "fast",
  "vision",
  "transcription",
  "speech",
  "image_generation",
  "embeddings",
]);
const zToolMode = z.enum(["allowed", "approval", "disabled"]);
const zJobState = z.enum([
  "queued",
  "planning",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
const zTemplateStatus = z.enum(["draft", "published", "disabled", "retired"]);
const zMaybeNum = z.number().nullable();

// ───────────── Overview and operations ─────────────

export const AdminWorkforceQuery = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

const zIssue = z.strictObject({
  severity: z.enum(["blocking", "warning"]),
  area: z.string(),
  message: z.string(),
});

export const AdminWorkforceOverview = z.strictObject({
  generatedAt: zTime,
  days: zCount,
  controls: z.strictObject({
    aiEnabled: z.boolean(),
    workforceEnabled: z.boolean(),
    paused: z.boolean(),
    maxConcurrency: zCount,
    approvalFloor: z.enum(["standard", "strict"]),
    secretsAvailable: z.boolean(),
  }),
  worker: z.strictObject({
    workerId: z.string(),
    running: zCount,
    lastTickAt: zTime.nullable(),
    claimed: zCount,
    completed: zCount,
    failed: zCount,
    recovered: zCount,
    lastError: z.string().nullable(),
    ticking: z.boolean(),
  }),
  mediaEngine: z.strictObject({
    available: z.boolean(),
    version: z.string().nullable(),
    burnCaptions: z.boolean(),
    textOverlay: z.boolean(),
    detail: z.string(),
  }),
  queue: z.array(z.strictObject({ state: zJobState, count: zCount })),
  oldestQueuedAt: zTime.nullable(),
  jobs: z.strictObject({
    created: zCount,
    completed: zCount,
    failed: zCount,
    cancelled: zCount,
    active: zCount,
    runtimeP50Ms: zMaybeNum,
    runtimeP95Ms: zMaybeNum,
    byAgent: z.array(
      z.strictObject({
        agentId: z.string(),
        created: zCount,
        completed: zCount,
        failed: zCount,
      }),
    ),
    byOrg: z.array(
      z.strictObject({
        orgId: z.string(),
        name: z.string().nullable(),
        created: zCount,
        completed: zCount,
        failed: zCount,
      }),
    ),
    failures: z.array(z.strictObject({ code: z.string(), count: zCount })),
    /** Failed requests that never sent a model request (refused before reaching a provider): they cost nothing. */
    failedBeforeModel: zCount,
  }),
  usage: z.strictObject({
    requests: zCount,
    failed: zCount,
    inputTokens: zCount,
    outputTokens: zCount,
    estimatedCostMicro: zCount,
    unpricedRequests: zCount,
    byCapability: z.array(
      z.strictObject({
        capability: z.string(),
        requests: zCount,
        failed: zCount,
        costMicro: zCount,
      }),
    ),
    byProvider: z.array(
      z.strictObject({
        providerId: z.string(),
        model: z.string(),
        requests: zCount,
        failed: zCount,
        costMicro: zCount,
        p50Ms: zMaybeNum,
      }),
    ),
    byOrg: z.array(
      z.strictObject({
        orgId: z.string(),
        requests: zCount,
        costMicro: zCount,
      }),
    ),
    mediaSeconds: zCount,
    /** The console's own verification requests (real provider calls, not agents' usage). */
    verifications: z.strictObject({ requests: zCount, failed: zCount }),
  }),
  storage: z.strictObject({
    files: zCount,
    bytes: zCount,
    artifacts: zCount,
    inputs: zCount,
  }),
  installs: z.strictObject({
    active: zCount,
    disabled: zCount,
    communities: zCount,
  }),
  issues: z.array(zIssue),
});

export const AdminWorkforceControlsBody = z.strictObject({
  workforceEnabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  maxConcurrency: z.number().int().min(0).max(16).optional(),
  approvalFloor: z.enum(["standard", "strict"]).optional(),
  reason: zReason,
});

// ───────────── Models and routing ─────────────

const zCapabilityState = z.strictObject({
  capability: zCapability,
  supportedByAdapter: z.boolean(),
  enabled: z.boolean(),
  verifiedAt: zTime.nullable(),
  verifyOk: z.boolean().nullable(),
  verifyDetail: z.string().nullable(),
});
const zRouteRef = z.strictObject({ providerId: zRef, model: zAiModel });

export const AdminAiModels = z.strictObject({
  models: z.array(
    z.strictObject({
      providerId: z.string(),
      providerName: z.string(),
      kind: z.string(),
      providerEnabled: z.boolean(),
      model: z.string(),
      enabled: z.boolean(),
      qualityRank: zMaybeNum,
      autoRoutable: z.boolean(),
      inputPriceMicro: zMaybeNum,
      outputPriceMicro: zMaybeNum,
      requestPriceMicro: zMaybeNum,
      minutePriceMicro: zMaybeNum,
      circuitOpen: z.boolean(),
      capabilities: z.array(zCapabilityState),
    }),
  ),
  routing: z.array(
    z.strictObject({
      category: zCategory,
      label: z.string(),
      capability: zCapability,
      providerId: z.string().nullable(),
      model: z.string().nullable(),
      fallbacks: z.array(
        z.strictObject({ providerId: z.string(), model: z.string() }),
      ),
      prefer: z.enum(["quality", "cost", "latency"]),
      maxPriceMicro: zMaybeNum,
      updatedAt: zTime.nullable(),
      /** ready · not_configured · untested · failed · unavailable (provider failing now) · disabled (switch or policy). */
      status: z.enum(["ready", "not_configured", "untested", "failed", "unavailable", "disabled"]),
      statusDetail: z.string(),
      /** The default model's last verification for this route's capability (null: no default, or it isn't on). */
      verification: z
        .strictObject({
          at: zTime.nullable(),
          ok: z.boolean().nullable(),
          detail: z.string().nullable(),
        })
        .nullable(),
      /** The latest agent request this route served. */
      lastExecution: z
        .strictObject({
          at: zTime,
          providerId: z.string(),
          model: z.string(),
          outcome: z.string(),
          errorKind: z.string().nullable(),
        })
        .nullable(),
      /** What `auto` would try right now, in order, and why the others are left out. */
      route: z.array(
        z.strictObject({
          providerId: z.string(),
          model: z.string(),
          reason: z.string(),
        }),
      ),
      excluded: z.array(
        z.strictObject({
          providerId: z.string(),
          model: z.string(),
          why: z.string(),
          code: z.string(),
        }),
      ),
    }),
  ),
  recentDecisions: z.array(
    z.strictObject({
      at: zTime,
      providerId: z.string(),
      model: z.string(),
      capability: z.string().nullable(),
      route: z.string().nullable(),
      outcome: z.string(),
      errorKind: z.string().nullable(),
      latencyMs: zMaybeNum,
    }),
  ),
});

export const AdminModelPath = z.strictObject({
  providerId: zRef,
  model: zAiModel,
});
export const AdminCapabilitiesBody = z.strictObject({
  capabilities: z.array(zCapability).max(6),
  qualityRank: z.number().int().min(1).max(1000).nullable().optional(),
  autoRoutable: z.boolean().optional(),
  /** Micro-USD per image or speech request, and per transcribed minute (from the provider's price page). */
  requestPriceMicro: z.number().int().min(0).max(1e12).nullable().optional(),
  minutePriceMicro: z.number().int().min(0).max(1e12).nullable().optional(),
  reason: zReason,
});
export const AdminVerifyBody = z.strictObject({
  capability: zCapability,
  reason: zReason,
});
export const AdminVerified = z.strictObject({
  ok: z.boolean(),
  detail: z.string(),
  latencyMs: zCount,
  /** On failure, what to do next (invalid key, no access to the model, out of credit, wrong kind of output…). */
  nextStep: z.string().nullable(),
});
/** Setting an approved model up for agents in one step: Text on, then the same real verification request. */
export const AdminAgentSetupBody = z.strictObject({ reason: zReason });
export const AdminRoutingParams = z.strictObject({ category: zCategory });
/** One-step route set-up: approve the model if needed, turn the capability on, verify, activate only if verified. */
export const AdminRouteSetupBody = z.strictObject({
  providerId: zRef,
  model: zAiModel,
  reason: zReason,
});
export const AdminRouteSetup = AdminVerified.extend({
  /** Whether it became the route's default (only after its verification passed). */
  activated: z.boolean(),
  models: AdminAiModels,
});
export const AdminRoutingBody = z.strictObject({
  providerId: zRef.nullable(),
  model: zAiModel.nullable(),
  fallbacks: z.array(zRouteRef).max(5),
  prefer: z.enum(["quality", "cost", "latency"]),
  maxPriceMicro: z.number().int().min(0).max(1e12).nullable(),
  reason: zReason,
});

// ───────────── Catalog ─────────────

const zPolicyDoc = z.strictObject({
  maxRuntimeSec: z.number().int().min(10).max(3600).optional(),
  maxJobsPerDay: z.number().int().min(0).max(10_000).optional(),
  forceReview: z.boolean().optional(),
});

export const AdminCatalog = z.strictObject({
  agents: z.array(
    z.strictObject({
      id: z.string(),
      version: zCount,
      name: z.string(),
      description: z.string(),
      category: z.string(),
      skill: z.strictObject({
        id: z.string(),
        version: zCount,
        tools: z.array(z.string()),
        requiredTools: z.array(z.string()),
        modelCategories: z.array(z.string()),
        requiredModelCategories: z.array(z.string()),
        maxRuntimeSec: zCount,
        maxModelCalls: zCount,
      }),
      capabilities: z.array(z.string()),
      integrations: z.array(
        z.strictObject({
          tool: z.string(),
          label: z.string(),
          connected: z.boolean(),
        }),
      ),
      approvals: z.array(z.string()),
      errors: z.array(z.string()),
      status: zTemplateStatus,
      availability: z.enum(["all", "entitled"]),
      policy: zPolicyDoc,
      updatedAt: zTime.nullable(),
      updatedBy: zPerson.nullable(),
      installs: z.strictObject({
        active: zCount,
        disabled: zCount,
        communities: zCount,
      }),
      jobs: z.strictObject({ completed: zCount, failed: zCount }),
      ready: z.boolean(),
      missing: z.array(z.string()),
    }),
  ),
});
export const AdminCatalogParams = z.strictObject({
  agentId: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  version: z.coerce.number().int().positive(),
});
export const AdminCatalogBody = z.strictObject({
  status: zTemplateStatus.optional(),
  availability: z.enum(["all", "entitled"]).optional(),
  policy: zPolicyDoc.optional(),
  reason: zReason,
});

// ───────────── Tools ─────────────

export const AdminTools = z.strictObject({
  tools: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
      description: z.string(),
      risk: z.enum(["internal", "consequential", "external"]),
      mode: zToolMode,
      defaultMode: zToolMode,
      hard: z.boolean(),
      connected: z.boolean(),
      integration: z.string().nullable(),
      denied30d: zCount,
      used30d: zCount,
    }),
  ),
});
export const AdminToolParams = z.strictObject({
  tool: z.string().regex(/^[a-z]+\.[a-z_]+$/),
});
export const AdminToolBody = z.strictObject({
  mode: zToolMode,
  reason: zReason,
});

// ───────────── Entitlements ─────────────

const zEntitlementDoc = z.strictObject({
  enabled: z.boolean(),
  agents: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/))
    .max(100)
    .nullable(),
  categories: z.array(z.string().max(40)).max(40).nullable(),
  models: z.array(z.string().max(200)).max(100).nullable(),
  tools: z.array(z.string().max(40)).max(40).nullable(),
  maxActiveJobs: z.number().int().min(0).max(1000).nullable(),
  maxConcurrentJobs: z.number().int().min(0).max(16).nullable(),
});
export const AdminOrgAi = z.strictObject({
  orgId: z.string(),
  name: z.string().nullable(),
  entitlement: zEntitlementDoc,
  rev: zCount,
  explicit: z.boolean(),
  installs: z.array(
    z.strictObject({
      installId: z.string(),
      agentId: z.string(),
      version: zCount,
      state: z.string(),
      displayName: z.string(),
      channels: zCount,
      createdAt: zTime,
    }),
  ),
  usage: z.strictObject({
    jobs30d: zCount,
    failed30d: zCount,
    active: zCount,
    requests30d: zCount,
    costMicro30d: zCount,
    fileBytes: zCount,
  }),
});
export const AdminOrgAiBody = z.strictObject({
  entitlement: zEntitlementDoc,
  rev: zCount,
  reason: zReason,
});
export const AdminAiEntitlements = z.strictObject({
  orgs: z.array(
    z.strictObject({
      orgId: z.string(),
      name: z.string().nullable(),
      enabled: z.boolean(),
      restricted: z.array(z.string()),
      updatedAt: zTime,
    }),
  ),
});

// ───────────── Jobs ─────────────

export const AdminJobsQuery = z.strictObject({
  state: zJobState.optional(),
  orgId: zRef.optional(),
  agentId: z.string().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const zAdminJob = z.strictObject({
  id: z.string(),
  orgId: z.string(),
  orgName: z.string().nullable(),
  agentId: z.string(),
  version: zCount,
  skillId: z.string(),
  state: zJobState,
  progress: zCount,
  depth: zCount,
  parentJobId: z.string().nullable(),
  attempts: zCount,
  maxAttempts: zCount,
  revision: zCount,
  inChannel: z.boolean(),
  error: z.strictObject({ code: z.string() }).nullable(),
  files: zCount,
  fileBytes: zCount,
  modelRequests: zCount,
  costMicro: zCount,
  createdAt: zTime,
  startedAt: zTime.nullable(),
  finishedAt: zTime.nullable(),
});
export const AdminJobs = z.strictObject({
  jobs: z.array(zAdminJob),
  next: zTime.nullable(),
});
export const AdminJobParams = z.strictObject({ jobId: zRef });
export const AdminSystemCheckParams = z.strictObject({ checkId: zRef });
export const AdminJobDetail = z.strictObject({
  job: zAdminJob,
  /** For a failed job: where it stopped, why, and how it can be recovered (no content). */
  diagnosis: z
    .strictObject({
      stage: z.enum(["before any model request", "after model requests"]),
      category: zCategory.nullable(),
      reason: z.string(),
      retryReady: z.boolean().nullable(),
      recovery: z.string(),
    })
    .nullable(),
  /** Kinds and numbers only (states, steps, tools, models, error kinds): no content. */
  events: z.array(
    z.strictObject({
      at: zTime,
      kind: z.string(),
      detail: z.record(z.string(), z.unknown()),
    }),
  ),
  steps: z.array(zAdminJob),
});
export const AdminJobCancelBody = z.strictObject({ reason: zReason });
