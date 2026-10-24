import type { AppContext } from "../../app/context.js";
import type { Deps, WorkforceSettings } from "./access.js";
import { Approvals } from "./approvals.js";
import { findAgent } from "./catalog/index.js";
import { AiFiles } from "./files.js";
import { JobStore } from "./jobs.js";
import { AgentPosts } from "./posts.js";
import { Automation } from "./automation.js";
import { SharedMessageStore } from "./sharedMessages.js";
import { TaskService } from "./taskService.js";
import { TaskStore } from "./taskStore.js";
import { TriggerStore } from "./triggers.js";
import { WorkforceConsoleView } from "./consoleView.js";
import { WorkforceRuntime } from "./runtime.js";
import { Workforce } from "./service.js";
import { WorkforceStore } from "./store.js";
import { ToolGateway } from "./tools.js";

/**
 * AI Workforce's public API (docs/AI_WORKFORCE.md): one runtime shared by the communities' agents and the Platform
 * Admin Console's AI Control Center. The console (modules/platformAdmin) reads and changes the same records the job
 * worker obeys, so its controls take effect at run time.
 */
export class WorkforceModule implements Deps {
  readonly store: WorkforceStore;
  readonly jobs: JobStore;
  readonly files: AiFiles;
  readonly approvals: Approvals;
  readonly posts: AgentPosts;
  readonly shared: SharedMessageStore;
  readonly triggers: TriggerStore;
  readonly tasks: TaskStore;
  readonly taskService: TaskService;
  readonly service: Workforce;
  readonly tools: ToolGateway;
  readonly runtime: WorkforceRuntime;
  /** Triggers: schedules, webhooks and handoffs (automation.ts). */
  readonly automation: Automation;
  /** What the Platform Admin Console may use: metadata and operations, never content. */
  readonly console: WorkforceConsoleView;

  constructor(
    readonly ctx: AppContext,
    readonly settings: WorkforceSettings,
    readonly clock: () => number = Date.now,
  ) {
    this.store = new WorkforceStore(ctx.db, clock);
    this.jobs = new JobStore(ctx.db, clock);
    this.files = new AiFiles(ctx.db, ctx.blobs, clock);
    this.approvals = new Approvals(ctx.db, clock);
    this.posts = new AgentPosts(ctx.db, clock);
    this.shared = new SharedMessageStore(ctx.db, clock);
    this.triggers = new TriggerStore(ctx.db, clock);
    this.tasks = new TaskStore(ctx.db, clock);
    this.taskService = new TaskService(this);
    this.service = new Workforce(this);
    this.tools = new ToolGateway(this, async (parent, installId, input, dependsOn, label) => this.service.createChild(parent, installId, input, dependsOn, label));
    this.runtime = new WorkforceRuntime(this, this.tools, (id, version) => findAgent(id, version));
    this.automation = new Automation(this, this.service);
    this.runtime.hooks = {
      onTick: () => {
        void this.automation.fireDue();
        this.taskService.tick();
      },
      onCompleted: (jobId) => this.automation.onCompleted(jobId),
    };
    this.console = new WorkforceConsoleView(this);
  }

  /** Retention (runs with the server's cleanup): finished jobs, their files and posts after 30 days, shared messages after 7. */
  async cleanup(): Promise<{ jobs: number; files: number; posts: number }> {
    const files = await this.files.purgeExpired();
    const posts = this.posts.purgeExpired() + this.shared.purgeExpired();
    const jobs = this.jobs.purgeExpired().length;
    return { jobs, files, posts };
  }
}

export { default as workforceRoutes } from "./routes.js";
export { AGENTS, findAgent } from "./catalog/index.js";
export type { WorkforceSettings } from "./access.js";
export { mediaEngine } from "./media.js";
export { TOOL_INFO } from "./toolInfo.js";
export { TOOL_KEYS, type ToolKey, type ToolMode, AGENT_CATEGORIES } from "./types.js";
export { Entitlement, TemplatePolicy, type TemplateStatus } from "./store.js";
export { agentSummary } from "./service.js";
export { jobSummary } from "./views.js";
export { JOB_STATES, type JobState } from "./jobs.js";
export { type JobMeta, jobStateCounts, type WorkforceConsoleView } from "./consoleView.js";
