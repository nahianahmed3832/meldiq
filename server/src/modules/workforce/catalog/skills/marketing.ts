import { z } from "zod/v4";
import { ApiError } from "../../../../shared/errors.js";
import { untrusted } from "../../prompting.js";
import { defineSkill } from "../../types.js";
import { Brief, column, deliver, finish, htmlToText, MB, mdTable, median, num, parseCsv, readText, readTexts, requireInputs, round, Summary, TEXT_MIMES, toCsv } from "../common.js";

// ───────────── Social Media Manager ─────────────

export const PLATFORM_LIMITS = { x: 280, linkedin: 3000, instagram: 2200, facebook: 5000, tiktok: 2200, threads: 500 } as const;
const HASHTAG_LIMITS: Record<keyof typeof PLATFORM_LIMITS, number> = { x: 3, linkedin: 5, instagram: 30, facebook: 5, tiktok: 10, threads: 5 };
type Platform = keyof typeof PLATFORM_LIMITS;
const PLATFORMS = Object.keys(PLATFORM_LIMITS) as [Platform, ...Platform[]];

const SocialInput = z.strictObject({ brief: Brief, platforms: z.array(z.enum(PLATFORMS)).min(1).max(6).default(["linkedin", "x"]), posts: z.number().int().min(1).max(20).default(5) });
const SocialPost = z.object({ platform: z.enum(PLATFORMS), text: z.string().min(1).max(6000), hashtags: z.array(z.string().max(60)).max(30).default([]), when: z.string().max(60).default(""), visual: z.string().max(300).default("") });
const SocialOutput = z.strictObject({ posts: z.number().int(), overLimit: z.number().int(), fileIds: z.array(z.string()), published: z.literal(false), summary: Summary });

/** A post's length as the platform counts it (text and hashtags), and whether it fits. */
export function fits(p: z.infer<typeof SocialPost>): { length: number; ok: boolean; hashtagsOk: boolean } {
  const tags = p.hashtags.map((h) => `#${h.replace(/^#/, "").replace(/\s+/g, "")}`);
  const length = [...`${p.text}${tags.length ? `\n\n${tags.join(" ")}` : ""}`].length;
  return { length, ok: length <= PLATFORM_LIMITS[p.platform], hashtagsOk: tags.length <= HASHTAG_LIMITS[p.platform] };
}

export const socialSkill = defineSkill<z.infer<typeof SocialInput>, z.infer<typeof SocialOutput>>({
  id: "social.plan",
  version: 1,
  input: SocialInput,
  output: SocialOutput,
  tools: ["files.read", "files.write", "channel.post", "social.publish"],
  requiredTools: ["files.write"],
  categories: ["reasoning"],
  requiredCategories: ["reasoning"],
  files: { max: 5, maxBytes: 5 * MB, mimes: TEXT_MIMES },
  limits: { maxRuntimeSec: 180, maxModelCalls: 3, maxAttempts: 2, maxOutputFiles: 2 },
  approvals: ["Publishing (social.publish) needs approval and a connected social account; no connection exists, so posts are delivered as a content calendar."],
  errors: ["A post over its platform's limit is rewritten once; if still over, it's marked in the calendar."],
  tests: ["ai_workforce_skills.test.ts"],
  async run(ctx, input) {
    // Captions of a video it's given (a video step it waited for) count as text: posts can quote what's said in it.
    const sources = await readTexts(ctx, [...TEXT_MIMES, "application/x-subrip"], 40_000);
    const system = `Write ${input.posts} social posts for: ${input.platforms.join(", ")}. Limits in characters including hashtags: ${input.platforms.map((p) => `${p} ${PLATFORM_LIMITS[p]} (${HASHTAG_LIMITS[p]} hashtags max)`).join(", ")}. Only facts from the brief. JSON only: {"posts":[{"platform","text","hashtags","when","visual"}]}.`;
    const prompt = `${untrusted("brief", input.brief)}${sources.length ? `\n\n${sources.map((s) => untrusted(s.name, s.text)).join("\n\n")}` : ""}`;
    const Answer = z.object({ posts: z.array(SocialPost).min(1).max(40) });
    let posts = (await ctx.models.json("reasoning", Answer, { system, prompt, maxOutputTokens: 4000 })).posts.filter((p) => input.platforms.includes(p.platform)).slice(0, input.posts * 2);
    const over = posts.filter((p) => !fits(p).ok || !fits(p).hashtagsOk);
    if (over.length) {
      const fixed = await ctx.models.json("reasoning", Answer, { system, prompt: `These posts are over their platform's limits. Shorten each, same order:\n${untrusted("posts", JSON.stringify(over))}`, maxOutputTokens: 3000 });
      posts = posts.map((p) => {
        const i = over.indexOf(p);
        const f = i >= 0 ? fixed.posts[i] : undefined;
        return f && f.platform === p.platform ? f : p;
      });
    }
    const header = ["Platform", "When", "Text", "Hashtags", "Length", "Limit", "Fits", "Visual"];
    const rows = posts.map((p) => {
      const f = fits(p);
      return [p.platform, p.when, p.text, p.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" "), f.length, PLATFORM_LIMITS[p.platform], f.ok && f.hashtagsOk ? "yes" : "NO", p.visual];
    });
    const overLimit = rows.filter((r) => r[6] === "NO").length;
    const csv = await deliver(ctx, "content-calendar.csv", "text/csv", toCsv(header, rows));
    const md = await deliver(ctx, "social-posts.md", "text/markdown", `# Social posts\n\n${posts.map((p, i) => `## ${i + 1}. ${p.platform}${p.when ? ` · ${p.when}` : ""}\n\n${p.text}\n\n${p.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}${p.visual ? `\n\n*Visual:* ${p.visual}` : ""}${rows[i]![6] === "NO" ? "\n\n**Over the platform's limit.**" : ""}`).join("\n\n")}\n`);
    const summary = `${posts.length} posts for ${input.platforms.join(", ")}${overLimit ? `; ${overLimit} still over a limit` : ""}. Not published: no social account is connected.`;
    return finish(ctx, { posts: posts.length, overLimit, fileIds: [md.id, csv.id], published: false, summary }, summary, [md.id, csv.id]);
  },
});

// ───────────── Performance Marketing ─────────────

export interface CampaignMetrics {
  campaign: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  convRate: number | null;
}

/** Totals per campaign and the standard ratios, from an ad export. Columns are found by common names. */
export function campaignMetrics(csv: string): { rows: CampaignMetrics[]; missing: string[] } {
  const { header, rows } = parseCsv(csv);
  const col = {
    campaign: column(header, ["campaign", "campaign name", "campaignname", "ad set", "adset"]),
    spend: column(header, ["spend", "cost", "amount spent", "amountspent"]),
    impressions: column(header, ["impressions", "impr"]),
    clicks: column(header, ["clicks", "link clicks", "linkclicks"]),
    conversions: column(header, ["conversions", "results", "purchases", "conv"]),
    revenue: column(header, ["revenue", "conversion value", "conversionvalue", "purchase value", "value"]),
  };
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (col.campaign < 0 || col.spend < 0) return { rows: [], missing };
  const by = new Map<string, CampaignMetrics>();
  for (const r of rows) {
    const name = (r[col.campaign] ?? "").trim() || "(unnamed)";
    const m = by.get(name) ?? { campaign: name, spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, ctr: null, cpc: null, cpa: null, roas: null, convRate: null };
    const add = (k: "spend" | "impressions" | "clicks" | "conversions" | "revenue") => (col[k] >= 0 ? (num(r[col[k]]) ?? 0) : 0);
    by.set(name, { ...m, spend: m.spend + add("spend"), impressions: m.impressions + add("impressions"), clicks: m.clicks + add("clicks"), conversions: m.conversions + add("conversions"), revenue: m.revenue + add("revenue") });
  }
  const ratio = (a: number, b: number, scale = 1) => (b > 0 ? round((a / b) * scale, 4) : null);
  return {
    rows: [...by.values()].map((m) => ({ ...m, spend: round(m.spend), revenue: round(m.revenue), ctr: ratio(m.clicks, m.impressions, 100), cpc: ratio(m.spend, m.clicks), cpa: ratio(m.spend, m.conversions), roas: ratio(m.revenue, m.spend), convRate: ratio(m.conversions, m.clicks, 100) })),
    missing,
  };
}

const PerfOutput = z.strictObject({ campaigns: z.number().int(), totals: z.strictObject({ spend: z.number(), revenue: z.number(), conversions: z.number(), roas: z.number().nullable() }), flags: z.array(z.string()), fileIds: z.array(z.string()), summary: Summary });
const Recs = z.object({
  recommendations: z.array(z.object({ campaign: z.string().max(200).nullable().default(null), action: z.string().max(500), rationale: z.string().max(800) })).max(15),
  experiments: z.array(z.object({ hypothesis: z.string().max(400), metric: z.string().max(100), design: z.string().max(600) })).max(8).default([]),
});

export const performanceSkill = defineSkill<{ brief: string }, z.infer<typeof PerfOutput>>({
  id: "marketing.performance",
  version: 1,
  input: z.strictObject({ brief: Brief }),
  output: PerfOutput,
  tools: ["files.read", "files.write", "channel.post", "ads.manage"],
  requiredTools: ["files.read", "files.write"],
  categories: ["reasoning"],
  requiredCategories: ["reasoning"],
  files: { min: 1, max: 3, maxBytes: 20 * MB, mimes: ["text/csv"] },
  limits: { maxRuntimeSec: 180, maxModelCalls: 2, maxAttempts: 2, maxOutputFiles: 2 },
  approvals: ["Launching campaigns or changing budgets (ads.manage) needs approval and an ad account connection; none exists, so it recommends."],
  errors: ["No CSV, or no campaign and spend columns: refused with the column names it looks for."],
  tests: ["ai_workforce_skills.test.ts"],
  async run(ctx, input) {
    const file = requireInputs(ctx, ["text/csv"], "an ad performance export (CSV)")[0]!;
    const src = await readText(ctx, file, 10_000_000);
    const { rows, missing } = campaignMetrics(src.text);
    if (!rows.length) throw new ApiError(400, "bad_request", `The CSV needs a campaign and a spend column (also used: impressions, clicks, conversions, revenue). Missing: ${missing.join(", ")}.`);
    const totals = rows.reduce((t, r) => ({ spend: t.spend + r.spend, revenue: t.revenue + r.revenue, conversions: t.conversions + r.conversions }), { spend: 0, revenue: 0, conversions: 0 });
    const medCpa = median(rows.flatMap((r) => (r.cpa === null ? [] : [r.cpa])));
    const medCtr = median(rows.flatMap((r) => (r.ctr === null ? [] : [r.ctr])));
    const flags = rows.flatMap((r) => [
      ...(r.spend > 0 && r.conversions === 0 ? [`${r.campaign}: ${r.spend} spent, no conversions`] : []),
      ...(medCpa !== null && r.cpa !== null && r.cpa > 2 * medCpa ? [`${r.campaign}: cost per conversion ${r.cpa}, over twice the median ${round(medCpa)}`] : []),
      ...(medCtr !== null && r.ctr !== null && r.ctr < medCtr / 2 ? [`${r.campaign}: click rate ${r.ctr}%, under half the median ${round(medCtr)}%`] : []),
      ...(r.roas !== null && r.roas < 1 && r.revenue > 0 ? [`${r.campaign}: returns ${r.roas} per unit spent (losing money)`] : []),
    ]);
    const header = ["Campaign", "Spend", "Impressions", "Clicks", "Conversions", "Revenue", "CTR %", "CPC", "CPA", "ROAS", "Conv. rate %"];
    const table = rows.map((r) => [r.campaign, r.spend, r.impressions, r.clicks, r.conversions, r.revenue, r.ctr, r.cpc, r.cpa, r.roas, r.convRate]);
    const recs = await ctx.models.json("reasoning", Recs, {
      system: 'You\'re a performance marketer. Recommend actions and experiments from the computed metrics only; don\'t restate or recompute figures differently. JSON only: {"recommendations":[{"campaign","action","rationale"}],"experiments":[{"hypothesis","metric","design"}]}.',
      prompt: `${untrusted("brief", input.brief)}\n\nMetrics (computed from the export):\n${untrusted("metrics", mdTable(header, table))}\n\nFlags:\n${flags.join("\n") || "none"}`,
      maxOutputTokens: 2500,
    });
    const roas = totals.spend > 0 ? round(totals.revenue / totals.spend, 2) : null;
    const md = `# Campaign performance\n\nSpend ${round(totals.spend)}, revenue ${round(totals.revenue)}, ${totals.conversions} conversions${roas !== null ? `, ROAS ${roas}` : ""}.\n\n${mdTable(header, table)}\n\n## Flags\n\n${flags.map((f) => `- ${f}`).join("\n") || "None."}\n\n## Recommendations\n\n${recs.recommendations.map((r) => `- **${r.campaign ?? "All"}**: ${r.action} — ${r.rationale}`).join("\n")}\n\n## Experiments\n\n${recs.experiments.map((e) => `- ${e.hypothesis} (metric: ${e.metric}). ${e.design}`).join("\n") || "None."}\n\nChanging campaigns or budgets needs an ad account connection, which isn't available: these are recommendations.\n`;
    const report = await deliver(ctx, "campaign-report.md", "text/markdown", md);
    const metrics = await deliver(ctx, "campaign-metrics.csv", "text/csv", toCsv(header, table));
    const summary = `${rows.length} campaigns analysed; ${flags.length} flags; ${recs.recommendations.length} recommendations.`;
    return finish(ctx, { campaigns: rows.length, totals: { spend: round(totals.spend), revenue: round(totals.revenue), conversions: totals.conversions, roas }, flags, fileIds: [report.id, metrics.id] , summary }, summary, [report.id, metrics.id]);
  },
});

// ───────────── SEO and Website Growth ─────────────

export interface PageAudit {
  page: string;
  title: string | null;
  issues: { severity: "high" | "medium" | "low"; check: string; detail: string }[];
  words: number;
}

const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;

/** On-page checks of one HTML page: title, description, headings, images, language, viewport, canonical, indexing. */
export function auditHtml(page: string, html: string): PageAudit {
  const issues: PageAudit["issues"] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  if (!title) issues.push({ severity: "high", check: "title", detail: "No <title>." });
  else if (title.length < 10 || title.length > 60) issues.push({ severity: "medium", check: "title", detail: `Title is ${title.length} characters (10–60 recommended).` });
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const desc = metas.find((m) => /name\s*=\s*["']description["']/i.test(m));
  const descText = desc ? attr(desc, "content") : null;
  if (!descText) issues.push({ severity: "high", check: "meta description", detail: "No meta description." });
  else if (descText.length < 50 || descText.length > 160) issues.push({ severity: "low", check: "meta description", detail: `Description is ${descText.length} characters (50–160 recommended).` });
  if (metas.some((m) => /name\s*=\s*["']robots["']/i.test(m) && /noindex/i.test(m))) issues.push({ severity: "high", check: "indexing", detail: "The page asks search engines not to index it (noindex)." });
  if (!metas.some((m) => /name\s*=\s*["']viewport["']/i.test(m))) issues.push({ severity: "medium", check: "mobile", detail: "No viewport meta tag." });
  if (!/<html\b[^>]*\blang\s*=/i.test(html)) issues.push({ severity: "low", check: "language", detail: "No lang attribute on <html>." });
  if (!/<link\b[^>]*rel\s*=\s*["']canonical["']/i.test(html)) issues.push({ severity: "low", check: "canonical", detail: "No canonical link." });
  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  if (h1 !== 1) issues.push({ severity: h1 === 0 ? "high" : "medium", check: "h1", detail: `${h1} <h1> headings (one recommended).` });
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const skip = levels.findIndex((l, i) => i > 0 && l > levels[i - 1]! + 1);
  if (skip > 0) issues.push({ severity: "low", check: "headings", detail: `Heading level jumps from h${levels[skip - 1]} to h${levels[skip]}.` });
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const noAlt = imgs.filter((t) => attr(t, "alt") === null || attr(t, "alt") === "").length;
  if (noAlt) issues.push({ severity: "medium", check: "images", detail: `${noAlt} of ${imgs.length} images have no alt text.` });
  const words = (htmlToText(html).match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (words < 300) issues.push({ severity: "low", check: "content", detail: `${words} words of text (thin content).` });
  return { page, title, issues, words };
}

const SeoInput = z.strictObject({ brief: Brief, urls: z.array(z.string().url().max(500)).max(5).default([]) });
const SeoOutput = z.strictObject({ pages: z.number().int(), issues: z.strictObject({ high: z.number().int(), medium: z.number().int(), low: z.number().int() }), fileIds: z.array(z.string()), summary: Summary });

export const seoSkill = defineSkill<z.infer<typeof SeoInput>, z.infer<typeof SeoOutput>>({
  id: "seo.audit",
  version: 1,
  input: SeoInput,
  output: SeoOutput,
  tools: ["files.read", "files.write", "channel.post", "web.fetch", "website.update"],
  requiredTools: ["files.write"],
  categories: ["reasoning"],
  requiredCategories: ["reasoning"],
  files: { max: 10, maxBytes: 5 * MB, mimes: ["text/html", "text/plain", "text/csv"] },
  limits: { maxRuntimeSec: 240, maxModelCalls: 2, maxAttempts: 2, maxOutputFiles: 2 },
  approvals: ["Changing a live website (website.update) needs approval and a website connection; none exists, so it recommends."],
  errors: ["No HTML pages and no fetchable addresses: refused. Pages that can't be fetched are listed and skipped."],
  tests: ["ai_workforce_skills.test.ts"],
  async run(ctx, input) {
    const pages: { name: string; html: string }[] = [];
    for (const f of ctx.inputs.filter((i) => i.mime === "text/html")) pages.push({ name: f.name, html: (await ctx.tool("files.read", { fileId: f.id })).bytes.toString("utf8") });
    const skipped: string[] = [];
    for (const url of input.urls) {
      try {
        const p = await ctx.tool("web.fetch", { url });
        if (p.contentType === "text/html") pages.push({ name: p.url, html: p.text });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        skipped.push(`${url} (${e.message})`);
      }
    }
    if (!pages.length) throw new ApiError(400, "bad_request", `Send the pages as HTML files${input.urls.length ? ` (the addresses couldn't be fetched: ${skipped.join("; ")})` : ", or page addresses if fetching pages is allowed here"}.`);
    const audits = pages.map((p) => auditHtml(p.name, p.html));
    const all = audits.flatMap((a) => a.issues.map((i) => ({ page: a.page, ...i })));
    const extra = (await readTexts(ctx, ["text/plain", "text/csv"], 30_000)).map((s) => untrusted(s.name, s.text)).join("\n\n");
    const plan = await ctx.models.json("reasoning", z.object({ priorities: z.array(z.object({ action: z.string().max(400), why: z.string().max(600), effort: z.enum(["low", "medium", "high"]) })).max(15) }), {
      system: 'Prioritise SEO fixes from the audit findings (and any analytics given). JSON only: {"priorities":[{"action","why","effort"}]}.',
      prompt: `${untrusted("brief", input.brief)}\n\nFindings:\n${untrusted("audit", all.map((i) => `${i.page} [${i.severity}] ${i.check}: ${i.detail}`).join("\n") || "none")}${extra ? `\n\nOther data:\n${extra}` : ""}`,
      maxOutputTokens: 2000,
    });
    const count = (s: "high" | "medium" | "low") => all.filter((i) => i.severity === s).length;
    const header = ["Page", "Severity", "Check", "Detail"];
    const rows = all.map((i) => [i.page, i.severity, i.check, i.detail]);
    const md = `# SEO audit\n\n${audits.length} page(s): ${count("high")} high, ${count("medium")} medium, ${count("low")} low issues.\n\n## Priorities\n\n${plan.priorities.map((p, i) => `${i + 1}. **${p.action}** (${p.effort} effort): ${p.why}`).join("\n")}\n\n## Findings\n\n${mdTable(header, rows)}\n${skipped.length ? `\nNot fetched: ${skipped.join("; ")}\n` : ""}\nChanging the live site needs a website connection, which isn't available: these are recommendations.\n`;
    const report = await deliver(ctx, "seo-audit.md", "text/markdown", md);
    const csv = await deliver(ctx, "seo-findings.csv", "text/csv", toCsv(header, rows));
    const summary = `${audits.length} page(s) audited: ${count("high")} high, ${count("medium")} medium, ${count("low")} low issues.`;
    return finish(ctx, { pages: audits.length, issues: { high: count("high"), medium: count("medium"), low: count("low") }, fileIds: [report.id, csv.id], summary }, summary, [report.id, csv.id]);
  },
});
