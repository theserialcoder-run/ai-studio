// ffmpeg / ffprobe helpers for Story Cuts. Server-only.
// Processes are spawned directly (never through a shell), so file paths can't inject commands.
// Install once: `sudo apt install ffmpeg` (or set FFMPEG_PATH / FFPROBE_PATH).
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ProviderError } from "./ai/http";

const ffmpegBin = () => (process.env.FFMPEG_PATH || "").trim() || "ffmpeg";
const ffprobeBin = () => (process.env.FFPROBE_PATH || "").trim() || "ffprobe";

interface RunOptions {
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
  timeoutMs?: number;
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: string; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "", stderrTail = "", outBuf = "", errBuf = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (stdout.length < 2_000_000) stdout += s;
      if (opts.onStdoutLine) {
        outBuf += s;
        const lines = outBuf.split("\n");
        outBuf = lines.pop() ?? "";
        lines.forEach(opts.onStdoutLine);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      if (opts.onStderrLine) {
        errBuf += s;
        const lines = errBuf.split("\n");
        errBuf = lines.pop() ?? "";
        lines.forEach(opts.onStderrLine);
      }
    });
    child.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (errBuf && opts.onStderrLine) opts.onStderrLine(errBuf);
      resolve({ code: code ?? -1, stdout, stderrTail });
    });
  });
}

let toolsOk: boolean | null = null;

/** Whether ffmpeg and ffprobe are installed. Success is cached; failure is re-checked each time. */
export async function mediaTools(): Promise<{ ok: boolean; error?: string }> {
  if (toolsOk) return { ok: true };
  try {
    const a = await run(ffmpegBin(), ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    const b = await run(ffprobeBin(), ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    toolsOk = a.code === 0 && b.code === 0;
  } catch {
    toolsOk = false;
  }
  return toolsOk ? { ok: true } : { ok: false, error: "ffmpeg is not installed. Install it once with: sudo apt install ffmpeg (then restart Wonderboy). Or set FFMPEG_PATH and FFPROBE_PATH." };
}

async function requireTools() {
  const t = await mediaTools();
  if (!t.ok) throw new ProviderError(t.error!, 400);
}

function ffError(what: string, tail: string): ProviderError {
  const last = tail.trim().split("\n").filter(l => l.trim()).slice(-3).join(" | ");
  return new ProviderError(`${what} failed. ffmpeg said: ${last.slice(0, 500) || "no output"}`, 500);
}

export interface Probe { duration: number; hasAudio: boolean; width: number; height: number }

export async function probe(file: string): Promise<Probe> {
  await requireTools();
  const r = await run(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw ffError("Reading the video", r.stderrTail);
  const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
  const video = j.streams?.find(s => s.codec_type === "video");
  if (!video) throw new ProviderError("This file has no video stream.", 400);
  const duration = Number(j.format?.duration ?? video.duration ?? 0);
  if (!(duration > 0)) throw new ProviderError("Could not read the video's duration.", 400);
  return { duration, hasAudio: !!j.streams?.some(s => s.codec_type === "audio"), width: video.width ?? 0, height: video.height ?? 0 };
}

const MIN_SCENE = 1.5;
const MAX_SCENE = 12;

/**
 * Finds hard cuts between `start` and `end` and returns scene ranges (seconds in the source).
 * Short scenes are merged into their neighbour; long ones are split evenly.
 */
export async function detectScenes(file: string, start: number, end: number, threshold: number, onProgress: (fraction: number) => void): Promise<{ start: number; end: number }[]> {
  await requireTools();
  const span = end - start;
  const cuts: number[] = [];
  const args = ["-hide_banner", "-nostats", "-ss", String(start), "-t", String(span), "-i", file, "-an", "-sn",
    "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-", "-progress", "pipe:1"];
  const r = await run(ffmpegBin(), args, {
    onStderrLine: line => {
      if (!line.includes("showinfo")) return;
      const m = /pts_time:\s*([\d.]+)/.exec(line);
      if (m) cuts.push(start + Number(m[1]));
    },
    onStdoutLine: line => {
      const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line);
      if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / span));
    },
    timeoutMs: 3 * 60 * 60_000,
  });
  if (r.code !== 0) throw ffError("Scene detection", r.stderrTail);

  const bounds = [start, ...cuts.filter(c => c > start + 0.2 && c < end - 0.2).sort((a, b) => a - b), end];
  let scenes = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1] }));
  // Merge scenes shorter than MIN_SCENE into the previous one (or the next, for the first).
  const merged: { start: number; end: number }[] = [];
  for (const s of scenes) {
    const prev = merged[merged.length - 1];
    if (prev && (s.end - s.start < MIN_SCENE || prev.end - prev.start < MIN_SCENE)) prev.end = s.end;
    else merged.push({ ...s });
  }
  scenes = merged;
  // Split long scenes into even parts of at most MAX_SCENE.
  const out: { start: number; end: number }[] = [];
  for (const s of scenes) {
    const parts = Math.max(1, Math.ceil((s.end - s.start) / MAX_SCENE));
    const len = (s.end - s.start) / parts;
    for (let i = 0; i < parts; i++) out.push({ start: round(s.start + i * len), end: round(i === parts - 1 ? s.end : s.start + (i + 1) * len) });
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** One small JPEG frame at `time` seconds. */
export async function extractFrame(file: string, time: number, outPath: string): Promise<void> {
  await requireTools();
  const r = await run(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.max(0, time)), "-i", file,
    "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", outPath], { timeoutMs: 120_000 });
  if (r.code !== 0) throw ffError("Extracting a frame", r.stderrTail);
}

export interface RenderPart {
  file: string; // source video
  start: number;
  duration: number; // output length of this part
  hasAudio: boolean;
  voiceFile: string | null; // WAV
}

const W = 1920, H = 1080, FPS = 30, VOICE_DELAY_MS = 150;

/** Renders each part to 1080p30 H.264/AAC, then joins them losslessly into `outPath`. */
export async function renderParts(parts: RenderPart[], filmVolume: number, workDir: string, outPath: string, onProgress: (fraction: number, message: string) => void): Promise<void> {
  await requireTools();
  await fs.mkdir(workDir, { recursive: true });
  const total = parts.reduce((s, p) => s + p.duration, 0) || 1;
  let done = 0;
  const partFiles: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const partFile = path.join(workDir, `part-${String(i).padStart(4, "0")}.mp4`);
    const args = ["-hide_banner", "-nostats", "-y", "-ss", String(p.start), "-i", p.file];
    let idx = 1;
    let voiceIdx = -1, silentIdx = -1;
    if (p.voiceFile) { args.push("-i", p.voiceFile); voiceIdx = idx++; }
    if (!p.hasAudio) { args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"); silentIdx = idx++; }
    const vol = Math.max(0, Math.min(1, filmVolume));
    const film = p.hasAudio ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol},apad[fa]` : `[${silentIdx}:a]anull[fa]`;
    const filters = [
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p,tpad=stop_mode=clone:stop_duration=${p.duration.toFixed(3)}[v]`,
      film,
    ];
    if (voiceIdx >= 0) {
      filters.push(`[${voiceIdx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${VOICE_DELAY_MS}|${VOICE_DELAY_MS},apad[va]`);
      filters.push(`[fa][va]amix=inputs=2:duration=first:normalize=0[a]`);
    } else {
      filters.push(`[fa]anull[a]`);
    }
    args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-t", p.duration.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
      "-progress", "pipe:1", partFile);
    const base = done;
    const r = await run(ffmpegBin(), args, {
      onStdoutLine: line => {
        const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line);
        if (m) onProgress(Math.min(1, (base + Math.min(p.duration, Number(m[1]) / 1e6)) / total), `Rendering part ${i + 1} of ${parts.length}…`);
      },
      timeoutMs: 60 * 60_000,
    });
    if (r.code !== 0) throw ffError(`Rendering part ${i + 1}`, r.stderrTail);
    partFiles.push(partFile);
    done += p.duration;
    onProgress(done / total, `Rendered part ${i + 1} of ${parts.length}`);
  }

  onProgress(1, "Joining parts…");
  const list = path.join(workDir, "parts.txt");
  await fs.writeFile(list, partFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const r = await run(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", outPath], { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw ffError("Joining the parts", r.stderrTail);
}
