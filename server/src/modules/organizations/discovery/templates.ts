import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import type { CommunityTemplate, TemplatePreview } from "../../../shared/contracts/http/communityTemplates.js";
import { ApiError } from "../../../shared/errors.js";
import { humanCode, newId } from "../../../shared/utilities/util.js";
import { notifyConversation } from "../orgsRoutes.js";
import { previewCategories, rebuild, Snapshot, snapshotCounts, takeSnapshot } from "./templateSnapshot.js";

/** Share codes are 12 characters from the readable alphabet (no I, L, O, 0 or 1), stored upper case. */
const CODE_LENGTH = 12;

interface TemplateRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  snapshot: string;
  uses: number;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
}

const notFound = () => new ApiError(404, "template_not_found", "There's no template with that code. It may have been deleted.");

function parseSnapshot(row: TemplateRow): Snapshot {
  const r = Snapshot.safeParse(JSON.parse(row.snapshot));
  if (!r.success) throw notFound();
  return r.data;
}

/**
 * Templates from a community (community parity batch E, feature "template-links"): one per community, made,
 * synced and deleted by people who can edit it; previewed by anyone signed in with the code; rebuilt into a new
 * community when POST /v1/orgs carries `templateCode`.
 */
export class CommunityTemplates {
  constructor(
    private readonly ctx: AppContext,
    readonly enabled: boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  requireEnabled(): void {
    if (!this.enabled) throw new ApiError(503, "feature_disabled", "Template links are switched off for now. Try again later.");
  }

  private row(orgId: string): TemplateRow | undefined {
    return this.ctx.ws.get<TemplateRow>("community_templates", { org_id: orgId });
  }

  private byCode(code: string): TemplateRow {
    const row = this.ctx.ws.get<TemplateRow>("community_templates", { code: code.toUpperCase() });
    if (!row) throw notFound();
    return row;
  }

  private view(row: TemplateRow): z.infer<typeof CommunityTemplate> {
    const stored = parseSnapshot(row);
    return {
      code: row.code,
      name: row.name,
      uses: row.uses,
      counts: snapshotCounts(stored),
      outOfDate: JSON.stringify(Snapshot.parse(takeSnapshot(this.ctx, row.org_id))) !== JSON.stringify(stored),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(orgId: string): z.infer<typeof CommunityTemplate> | null {
    const row = this.row(orgId);
    return row ? this.view(row) : null;
  }

  /** A new template of [orgId] named [name] (the community's name when left out); 409 template_exists when it has one. */
  async create(orgId: string, actorId: string, name: string | undefined): Promise<z.infer<typeof CommunityTemplate>> {
    const org = this.ctx.ws.get<{ name: string }>("orgs", { id: orgId })!;
    const t = this.clock();
    const snapshot = JSON.stringify(takeSnapshot(this.ctx, orgId));
    const row = await this.ctx.ws.write((w) => {
      if (w.get("community_templates", { org_id: orgId })) {
        throw new ApiError(409, "template_exists", "This community already has a template. Sync it or delete it to make a new one.");
      }
      let code = humanCode(CODE_LENGTH);
      while (w.get("community_templates", { code })) code = humanCode(CODE_LENGTH);
      const r: TemplateRow = { id: newId("tpl"), org_id: orgId, code, name: name ?? org.name, snapshot, uses: 0, created_by: actorId, created_at: t, updated_by: actorId, updated_at: t };
      w.insert("community_templates", { ...r });
      return r;
    });
    return this.view(row);
  }

  /** Copies the community into its template again (same code). */
  async sync(orgId: string, actorId: string): Promise<z.infer<typeof CommunityTemplate>> {
    if (!this.row(orgId)) throw new ApiError(404, "template_not_found", "This community has no template. Make one first.");
    const snapshot = JSON.stringify(takeSnapshot(this.ctx, orgId));
    await this.ctx.ws.write((w) => w.update("community_templates", { org_id: orgId }, { snapshot, updated_by: actorId, updated_at: this.clock() }));
    return this.view(this.row(orgId)!);
  }

  async remove(orgId: string): Promise<boolean> {
    if (!this.row(orgId)) return false;
    return (await this.ctx.ws.write((w) => w.delete("community_templates", { org_id: orgId }))) > 0;
  }

  preview(code: string): z.infer<typeof TemplatePreview> {
    const row = this.byCode(code);
    const s = parseSnapshot(row);
    const source = this.ctx.ws.get<{ id: string; name: string; photo_rev: number | null }>("orgs", { id: row.org_id });
    return {
      code: row.code,
      name: row.name,
      source: source ? { id: source.id, name: source.name, photoRev: source.photo_rev ?? null } : null,
      uses: row.uses,
      counts: snapshotCounts(s),
      updatedAt: row.updated_at,
      categories: previewCategories(s),
      roles: s.roles.map((r) => ({ name: r.name, color: r.color })),
    };
  }

  /** The snapshot behind [code], checked before a community is made from it (404 template_not_found). */
  snapshotFor(code: string): { templateId: string; snapshot: Snapshot } {
    this.requireEnabled();
    const row = this.byCode(code);
    return { templateId: row.id, snapshot: parseSnapshot(row) };
  }

  /** Builds [orgId] (just made by [ownerId]) from the template, and counts the use. Returns the new channel ids. */
  async build(orgId: string, ownerId: string, templateId: string, snapshot: Snapshot): Promise<string[]> {
    const t = this.clock();
    const roleLimit = this.ctx.entitlements.limitFor("roles.custom", orgId).limit;
    const channels = await this.ctx.ws.write((w) => {
      const made = rebuild(this.ctx, w, orgId, ownerId, snapshot, roleLimit, t);
      const tpl = w.get<TemplateRow>("community_templates", { id: templateId });
      if (tpl) w.update("community_templates", { id: templateId }, { uses: tpl.uses + 1 });
      return made;
    });
    for (const id of channels) notifyConversation(this.ctx, id);
    this.ctx.audit({ actorId: ownerId, orgId, action: "community.start", detail: `template ${templateId}: ${channels.length} channels, ${Math.min(snapshot.roles.length, roleLimit ?? Infinity)} roles` });
    return channels;
  }
}
