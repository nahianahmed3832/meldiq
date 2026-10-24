import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError } from "../../shared/errors.js";
import type { EditPlan, MediaInfo } from "./types.js";

/**
 * The media engine (docs/AI_WORKFORCE.md): ffmpeg and ffprobe, run with argument arrays the server builds itself from
 * a checked edit plan. No shell, no command text from a model, fixed codecs and sizes, a time limit and cancellation.
 * What this ffmpeg build can do is detected once: burned-in captions need the `subtitles` filter, text on the video
 * needs `drawtext` and a font; without them captions are a subtitle track plus an .srt file, and the job says so.
 */
export interface MediaEngine {
  available: boolean;
  version: string | null;
  burnCaptions: boolean;
  textOverlay: boolean;
  fontFile: string | null;
  detail: string;
}

export const MEDIA_LIMITS = {
  clips: 20,
  minClipSec: 0.5,
  maxOutputSec: 600,
  maxCaptionChars: 200,
  maxCaptions: 400,
  /** Time one ffmpeg run may take. */
  runMs: 15 * 60_000,
  probeMs: 30_000,
} as const;

const QUALITY = {
  preview: { long: 640, short: 360, crf: 32, audio: "96k" },
  final: { long: 1280, short: 720, crf: 21, audio: "160k" },
} as const;

const FONT_CANDIDATES = ["/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"];
const SAFE_PATH = /^[A-Za-z0-9/._-]+$/;

function run(bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ApiError(409, "job_cancelled", "The job was cancelled."));
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let size = 0;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= 64 * 1024 * 1024) out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-4000);
    });
    let killedBy: "timeout" | "cancel" | null = null;
    const timer = setTimeout(() => {
      killedBy = "timeout";
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const onAbort = () => {
      killedBy = "cancel";
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (killedBy === "cancel") return reject(new ApiError(409, "job_cancelled", "The job was cancelled."));
      if (killedBy === "timeout") return reject(new ApiError(504, "job_timeout", "The media engine took longer than its time limit."));
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

let detected: Promise<MediaEngine> | null = null;

/** What the server's ffmpeg can do (once per process). FFMPEG_PATH / FFPROBE_PATH / MEDIA_FONT_FILE override. */
export function mediaEngine(env: NodeJS.ProcessEnv = process.env): Promise<MediaEngine> {
  detected ??= (async () => {
    const ffmpeg = env.FFMPEG_PATH ?? "ffmpeg";
    try {
      const v = await run(ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 10_000 });
      const p = await run(env.FFPROBE_PATH ?? "ffprobe", ["-hide_banner", "-version"], { timeoutMs: 10_000 });
      if (v.code !== 0 || p.code !== 0) throw new Error("not runnable");
      const filters = (await run(ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 10_000 })).stdout.toString("utf8");
      const encoders = (await run(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 10_000 })).stdout.toString("utf8");
      if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) {
        return { available: false, version: null, burnCaptions: false, textOverlay: false, fontFile: null, detail: "ffmpeg lacks the libx264 or aac encoder" };
      }
      const has = (f: string) => new RegExp(`\\s${f}\\s`).test(filters);
      const font = env.MEDIA_FONT_FILE ?? FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;
      const version = /ffmpeg version (\S+)/.exec(v.stdout.toString("utf8"))?.[1] ?? "unknown";
      const textOverlay = has("drawtext") && font !== null && SAFE_PATH.test(font);
      return {
        available: true,
        version,
        burnCaptions: has("subtitles"),
        textOverlay,
        fontFile: textOverlay ? font : null,
        detail: `ffmpeg ${version}; captions ${has("subtitles") ? "burned in" : "as a subtitle track"}; text overlay ${textOverlay ? "available" : "not available"}`,
      };
    } catch {
      return { available: false, version: null, burnCaptions: false, textOverlay: false, fontFile: null, detail: "ffmpeg or ffprobe isn't installed on this server" };
    }
  })();
  return detected;
}

/** For tests: detect again (e.g. after changing FFMPEG_PATH). */
/** Runs ffmpeg now (not the cached detection): the System Check's proof that the engine still starts. */
export async function mediaEngineAnswers(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; detail: string }> {
  try {
    const v = await run(env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    const version = /ffmpeg version (\S+)/.exec(v.stdout.toString("utf8"))?.[1];
    return v.code === 0 ? { ok: true, detail: `ffmpeg ${version ?? "(version unknown)"} started` } : { ok: false, detail: `ffmpeg exited with ${v.code}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 200) : "ffmpeg couldn't start" };
  }
}

export function resetMediaEngine(): void {
  detected = null;
}

async function need(): Promise<MediaEngine> {
  const e = await mediaEngine();
  if (!e.available) throw new ApiError(503, "media_engine_unavailable", `The media engine isn't available: ${e.detail}.`);
  return e;
}

export async function probe(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  await need();
  const r = await run(process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: MEDIA_LIMITS.probeMs, signal });
  if (r.code !== 0) throw new ApiError(400, "bad_request", "That file isn't a video or audio file the media engine can read.");
  const j = JSON.parse(r.stdout.toString("utf8")) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
  const video = j.streams?.find((s) => s.codec_type === "video");
  const audio = j.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(j.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new ApiError(400, "bad_request", "That file has no duration the media engine can read.");
  return { durationSec: duration, hasVideo: !!video, hasAudio: !!audio, width: video?.width ?? null, height: video?.height ?? null };
}

/** The sound track as mono 16 kHz MP3 (what transcription needs, and small). */
export async function extractAudio(file: string, signal?: AbortSignal): Promise<Buffer> {
  await need();
  const r = await run(process.env.FFMPEG_PATH ?? "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1"], {
    timeoutMs: MEDIA_LIMITS.runMs,
    signal,
  });
  if (r.code !== 0 || r.stdout.length === 0) throw new ApiError(400, "bad_request", "That file has no sound track the media engine can read.");
  return r.stdout;
}

/** SRT text for caption segments (times in seconds on the output's timeline). */
export function toSrt(segments: { start: number; end: number; text: string }[]): string {
  const ts = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return segments.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text.replace(/\r?\n/g, " ").trim()}\n`).join("\n");
}

/**
 * Checks an edit plan against the sources' real durations: every clip inside its file, long enough, at most
 * MEDIA_LIMITS.clips clips and maxOutputSec in total, captions on the output's timeline and short.
 */
export function checkPlan(plan: EditPlan, sources: Map<string, MediaInfo>): { outputSec: number } {
  const bad = (m: string) => new ApiError(400, "bad_request", `The edit plan isn't valid: ${m}`);
  if (plan.clips.length === 0) throw bad("it has no clips.");
  if (plan.clips.length > MEDIA_LIMITS.clips) throw bad(`more than ${MEDIA_LIMITS.clips} clips.`);
  let total = 0;
  for (const c of plan.clips) {
    const info = sources.get(c.fileId);
    if (!info) throw bad("a clip names a file that wasn't submitted.");
    if (!info.hasVideo) throw bad("a clip's file has no video.");
    if (!(c.startSec >= 0 && c.endSec <= info.durationSec + 0.05 && c.endSec - c.startSec >= MEDIA_LIMITS.minClipSec)) throw bad(`a clip (${c.startSec}–${c.endSec} s) isn't inside its ${info.durationSec.toFixed(1)} s file.`);
    total += Math.min(c.endSec, info.durationSec) - c.startSec;
  }
  if (total > MEDIA_LIMITS.maxOutputSec) throw bad(`the video would be longer than ${MEDIA_LIMITS.maxOutputSec} seconds.`);
  if (plan.captions.length > MEDIA_LIMITS.maxCaptions) throw bad("too many captions.");
  for (const s of plan.captions) {
    if (!(s.start >= 0 && s.end > s.start && s.end <= total + 0.5)) throw bad("a caption is outside the video's timeline.");
    if (s.text.length > MEDIA_LIMITS.maxCaptionChars) throw bad("a caption is too long.");
  }
  if ((plan.title?.length ?? 0) > 80 || (plan.brandText?.length ?? 0) > 60) throw bad("the title or brand text is too long.");
  return { outputSec: total };
}

/**
 * Renders [plan] from local source files ([paths] by file id) to an MP4 at [quality], written to [outFile] (never held
 * in memory). Returns what was applied, so the deliverable can say exactly what it contains.
 */
export async function render(
  plan: EditPlan,
  sources: Map<string, MediaInfo>,
  paths: Map<string, string>,
  quality: "preview" | "final",
  outFile: string,
  signal?: AbortSignal,
): Promise<{ size: number; durationSec: number; captions: "burned" | "track" | "none"; overlay: boolean }> {
  const engine = await need();
  const { outputSec } = checkPlan(plan, sources);
  const q = QUALITY[quality];
  const first = sources.get(plan.clips[0]!.fileId)!;
  const portrait = (first.height ?? 0) > (first.width ?? 0);
  const [w, h] = portrait ? [q.short, q.long] : [q.long, q.short];
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "meldiq-render-"));
  try {
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
    const filters: string[] = [];
    const pairs: string[] = [];
    let input = 0;
    for (const c of plan.clips) {
      const info = sources.get(c.fileId)!;
      const dur = Math.min(c.endSec, info.durationSec) - c.startSec;
      args.push("-ss", c.startSec.toFixed(3), "-t", dur.toFixed(3), "-i", paths.get(c.fileId)!);
      const v = input++;
      let a = `${v}:a`;
      if (!info.hasAudio) {
        args.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
        a = `${input++}:a`;
      }
      const i = pairs.length;
      filters.push(`[${v}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
      filters.push(`[${a}]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      pairs.push(`[v${i}][a${i}]`);
    }
    filters.push(`${pairs.join("")}concat=n=${pairs.length}:v=1:a=1[vc][ac]`);
    let video = "vc";
    const overlay = engine.textOverlay && !!(plan.brandText || plan.title);
    if (overlay) {
      // The text goes through a file, never into the filter string, so nothing in it can change the filter.
      const parts: string[] = [];
      if (plan.title) {
        await fs.promises.writeFile(path.join(dir, "title.txt"), plan.title);
        parts.push(`drawtext=fontfile=${engine.fontFile}:textfile=title.txt:fontcolor=white:fontsize=${Math.round(h / 12)}:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=h*0.4:enable='lt(t,3)'`);
      }
      if (plan.brandText) {
        await fs.promises.writeFile(path.join(dir, "brand.txt"), plan.brandText);
        parts.push(`drawtext=fontfile=${engine.fontFile}:textfile=brand.txt:fontcolor=white@0.85:fontsize=${Math.round(h / 24)}:x=w-text_w-20:y=20`);
      }
      filters.push(`[${video}]${parts.join(",")}[vt]`);
      video = "vt";
    }
    let captions: "burned" | "track" | "none" = "none";
    if (plan.captions.length) {
      await fs.promises.writeFile(path.join(dir, "captions.srt"), toSrt(plan.captions));
      if (engine.burnCaptions) {
        filters.push(`[${video}]subtitles=captions.srt[vs]`);
        video = "vs";
        captions = "burned";
      } else {
        args.push("-i", path.join(dir, "captions.srt"));
        captions = "track";
      }
    }
    args.push("-filter_complex", filters.join(";"), "-map", `[${video}]`, "-map", "[ac]");
    if (captions === "track") args.push("-map", `${input}:s`, "-c:s", "mov_text");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", String(q.crf), "-c:a", "aac", "-b:a", q.audio, "-movflags", "+faststart");
    if (plan.title) args.push("-metadata", `title=${plan.title.replace(/[\r\n]/g, " ")}`);
    args.push("out.mp4");
    const r = await run(process.env.FFMPEG_PATH ?? "ffmpeg", args, { timeoutMs: MEDIA_LIMITS.runMs, signal, cwd: dir });
    if (r.code !== 0) throw new ApiError(500, "internal", `The media engine failed: ${r.stderr.split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "no detail"}`);
    const size = (await fs.promises.stat(path.join(dir, "out.mp4")).catch(() => null))?.size ?? 0;
    if (size === 0) throw new ApiError(500, "internal", "The media engine produced an empty file.");
    await fs.promises.copyFile(path.join(dir, "out.mp4"), outFile);
    return { size, durationSec: outputSec, captions, overlay };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
