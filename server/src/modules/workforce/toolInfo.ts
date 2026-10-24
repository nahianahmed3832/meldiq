import type { ToolKey, ToolMode, ToolRisk } from "./types.js";

/**
 * What each tool is, its risk and the platform's default ceiling (docs/AI_WORKFORCE.md §6–7). Operators change the
 * ceiling in the console (ai_tool_policies); a `hard` tool can't be turned on by anyone. External tools have no
 * connector on this server, so even when allowed they answer integration_not_configured.
 */
export interface ToolInfo {
  label: string;
  description: string;
  risk: ToolRisk;
  defaultMode: ToolMode;
  /** The platform can't allow it at all. */
  hard?: boolean;
  /** For external tools: the outside service it needs (none is connected). */
  integration?: string;
}

export const TOOL_INFO: Record<ToolKey, ToolInfo> = {
  "files.read": { label: "Read submitted files", description: "Read the files a person sent with the request, and files earlier steps of the same request made.", risk: "internal", defaultMode: "allowed" },
  "files.write": { label: "Create deliverables", description: "Store documents, images, videos and data files as deliverables of the job.", risk: "internal", defaultMode: "allowed" },
  "channel.post": { label: "Post in assigned channels", description: "Post progress and results (not end-to-end encrypted) in the channel the request came from, if the agent is assigned there.", risk: "internal", defaultMode: "allowed" },
  "media.probe": { label: "Inspect media", description: "Read the duration and streams of a submitted video or audio file.", risk: "internal", defaultMode: "allowed" },
  "media.render": { label: "Render video", description: "Cut, join, caption and brand submitted video with the server's media engine, from an edit plan the server checks.", risk: "internal", defaultMode: "allowed" },
  "media.extract_audio": { label: "Extract audio", description: "Take the sound track out of a video for transcription.", risk: "internal", defaultMode: "allowed" },
  "web.fetch": { label: "Fetch public web pages", description: "Read one public https page (no private addresses, 2 MB, 15 seconds, no redirects to private hosts).", risk: "consequential", defaultMode: "disabled" },
  "agents.delegate": { label: "Delegate to other agents", description: "The Agent Manager hands parts of a request to the community's installed agents, as the person who asked.", risk: "internal", defaultMode: "allowed" },
  "tasks.assign": { label: "Assign work to people", description: "The Agent Manager gives a task to someone the community allows it to assign work to (chosen by role and workload), as the person who asked; only when they may manage AI agents.", risk: "internal", defaultMode: "allowed" },
  "social.publish": { label: "Publish to social media", description: "Post to a social media account.", risk: "external", defaultMode: "approval", integration: "Social media account connection" },
  "ads.manage": { label: "Change ad campaigns", description: "Launch campaigns or change budgets.", risk: "external", defaultMode: "approval", integration: "Advertising account connection" },
  "email.send": { label: "Send email", description: "Send email to outside addresses.", risk: "external", defaultMode: "approval", integration: "Email account connection" },
  "calendar.write": { label: "Change calendars", description: "Create or change calendar events.", risk: "external", defaultMode: "approval", integration: "Calendar connection" },
  "crm.write": { label: "Update the CRM", description: "Create or change CRM records.", risk: "external", defaultMode: "approval", integration: "CRM connection" },
  "support.reply_external": { label: "Reply to customers", description: "Send replies to customers outside Meldiq.", risk: "external", defaultMode: "approval", integration: "Help desk connection" },
  "repository.write": { label: "Write to repositories", description: "Push commits or open pull requests.", risk: "external", defaultMode: "approval", integration: "Code repository connection" },
  "website.update": { label: "Update websites", description: "Change a live website.", risk: "external", defaultMode: "approval", integration: "Website or CMS connection" },
  "deploy.production": { label: "Deploy to production", description: "Run production deployments.", risk: "external", defaultMode: "disabled", integration: "Deployment pipeline connection" },
  "payments.execute": { label: "Make payments", description: "Payments and transfers. Never allowed for agents on this platform.", risk: "external", defaultMode: "disabled", hard: true, integration: "Payment provider connection" },
};
