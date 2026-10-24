import type { RoutingCategory } from "../ai/index.js";
import type { ToolKey } from "./types.js";

/**
 * The skill library's capabilities (skillLibrary.ts): what agents' skills can do, in machine-readable ids, and which
 * skill provides which, and what discovery answers. A leaf module (it imports only types), so skills can use it without
 * importing the catalog that holds them.
 */

export interface CapabilitySpec {
  label: string;
  /** The tool this capability can't work without beyond the skill's own required tools (an outside action, the web). */
  tool?: ToolKey;
  /** Model routes it needs beyond the skill's required ones (e.g. image generation for images). */
  categories?: readonly RoutingCategory[];
}

export const CAPABILITY_SPECS = {
  "orchestrate.plan": { label: "Plan and coordinate work across agents" },
  "text.answer": { label: "Answer questions" },
  "text.summarize": { label: "Summarise text and documents" },
  "text.write": { label: "Write articles, posts and marketing copy" },
  "research.report": { label: "Research reports with checked citations" },
  "web.read": { label: "Read public web pages", tool: "web.fetch" },
  "knowledge.answer": { label: "Answer from a knowledge base" },
  "code.review": { label: "Review and debug code" },
  "code.patch": { label: "Write code patches" },
  "repository.write": { label: "Push to code repositories", tool: "repository.write" },
  "deploy.production": { label: "Deploy to production", tool: "deploy.production" },
  "qa.test_plan": { label: "Test plans and bug reports" },
  "project.plan": { label: "Project plans, estimates and schedules" },
  "design.concept": { label: "Design concepts and palettes" },
  "image.generate": { label: "Generate images", categories: ["image_generation"] },
  "image.understand": { label: "Read images and screenshots", categories: ["vision"] },
  "video.edit": { label: "Edit video from submitted footage" },
  "audio.transcribe": { label: "Transcribe speech in audio and video", categories: ["transcription"] },
  "social.plan": { label: "Social media posts and content calendars" },
  "social.publish": { label: "Publish to social media", tool: "social.publish" },
  "ads.analyze": { label: "Analyse ad campaign results" },
  "ads.manage": { label: "Launch and change ad campaigns", tool: "ads.manage" },
  "seo.audit": { label: "SEO audits and fixes" },
  "website.update": { label: "Change a live website", tool: "website.update" },
  "ecommerce.inventory": { label: "Stock and inventory reports" },
  "ecommerce.product_copy": { label: "Product descriptions and launch checklists" },
  "support.triage": { label: "Sort customer messages by category and priority" },
  "support.draft_reply": { label: "Draft replies to customers" },
  "support.reply_external": { label: "Send replies to customers outside Meldiq", tool: "support.reply_external" },
  "sales.outreach": { label: "Sales outreach drafts and pipeline summaries" },
  "crm.write": { label: "Update the CRM", tool: "crm.write" },
  "email.draft": { label: "Draft and summarise email" },
  "email.send": { label: "Send email", tool: "email.send" },
  "calendar.invite": { label: "Calendar invitations as files" },
  "calendar.write": { label: "Change calendars", tool: "calendar.write" },
  "data.analyze": { label: "Analyse data files" },
  "hr.docs": { label: "Onboarding plans, policies and shift schedules" },
  "finance.analyze": { label: "Analyse transactions and spending" },
  "payments.execute": { label: "Make payments", tool: "payments.execute" },
  "meeting.minutes": { label: "Meeting minutes and action items" },
  "translate.text": { label: "Translate documents and subtitles" },
} as const satisfies Record<string, CapabilitySpec>;

export type CapabilityId = keyof typeof CAPABILITY_SPECS;
export const CAPABILITY_IDS = Object.keys(CAPABILITY_SPECS) as CapabilityId[];
export const isCapabilityId = (c: string): c is CapabilityId => Object.hasOwn(CAPABILITY_SPECS, c);

/** What each skill provides. A skill's tools and model routes decide whether a capability is usable, not this list. */
export const SKILL_PROVIDES: Record<string, readonly CapabilityId[]> = {
  "manager.orchestrate": ["orchestrate.plan", "text.answer"],
  "general.assist": ["text.answer", "text.summarize"],
  "research.report": ["research.report", "knowledge.answer", "web.read"],
  "coding.engineer": ["code.review", "code.patch", "repository.write", "deploy.production"],
  "qa.testing": ["qa.test_plan"],
  "project.plan": ["project.plan"],
  "content.write": ["text.write"],
  "design.image": ["design.concept", "image.generate", "image.understand"],
  "video.edit": ["video.edit", "audio.transcribe", "social.publish"],
  "social.plan": ["social.plan", "social.publish"],
  "marketing.performance": ["ads.analyze", "ads.manage"],
  "seo.audit": ["seo.audit", "web.read", "website.update"],
  "ecommerce.ops": ["ecommerce.inventory", "ecommerce.product_copy", "website.update"],
  "support.assist": ["support.triage", "support.draft_reply", "knowledge.answer", "support.reply_external"],
  "sales.crm": ["sales.outreach", "crm.write", "email.send"],
  "data.analyze": ["data.analyze"],
  "hr.ops": ["hr.docs"],
  "finance.analyze": ["finance.analyze", "payments.execute"],
  "meeting.docs": ["meeting.minutes", "audio.transcribe"],
  "email.calendar": ["email.draft", "calendar.invite", "email.send", "calendar.write"],
  "translation.localize": ["translate.text"],
};

export interface Provider {
  installId: string;
  agentId: string;
  name: string;
  ready: boolean;
  /** Plain sentences, each naming what's missing and who fixes it. Empty when ready. */
  blockers: string[];
}

export interface Discovered {
  capability: CapabilityId;
  label: string;
  /** ready: an installed agent can do it now · blocked: installed, but something's missing · not_installed: an agent in the catalog provides it · unavailable: nothing on this platform does. */
  status: "ready" | "blocked" | "not_installed" | "unavailable";
  providers: Provider[];
  /** Catalog agents that provide it and aren't installed in this community. */
  installable: { agentId: string; name: string }[];
}

/** One line per capability that isn't ready, for a coordinator's prompt or a person: what's missing and how to fix it. */
export function missingLines(found: readonly Discovered[]): string[] {
  return found
    .filter((f) => f.status !== "ready")
    .map((f) => {
      if (f.status === "blocked") return `${f.label}: ${f.providers.map((p) => `${p.name} can't yet (${p.blockers.slice(0, 2).join(" ")})`).join("; ")}`;
      if (f.status === "not_installed") return `${f.label}: no agent here does it; install ${f.installable.map((a) => a.name).join(" or ")}.`;
      return `${f.label}: no skill on this platform does it yet.`;
    });
}
