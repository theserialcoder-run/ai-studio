// Free stock footage for Story Cuts (stock mode). Server-only.
// Providers: Pixabay (preferred when PIXABAY_API_KEY is set) and Pexels (PEXELS_API_KEY).
// Pixabay API: https://pixabay.com/api/docs/ — free key, 100 requests/60 s, search results
// must be cached for 24 h, files must be downloaded (no hotlinking), plain-text errors.
// Pixabay licence: commercial use allowed; no standalone resale, no misleading/endorsement or
// offensive use of recognisable people, no trademarks/brands for commercial merchandise.
// Pexels API: https://www.pexels.com/api/documentation/ — free key, 200 requests/hour,
// 20,000/month. Pexels licence: free for commercial use; identifiable people must not be
// shown in a bad or offensive light, and endorsement must not be implied. Credit is appreciated
// (the UI offers a credits list for the video description).
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { countWords, wordBudget } from "../storyCut";
import type { Asset, StockOption, StoryCut, StoryCutLine, StoryCutSegment } from "../types";
import { env, explainHttpError, errorDetail, ProviderError } from "./ai/http";
import { activeLlm, chat } from "./ai/llm";
import { dataRoot, projectCacheDir, saveGeneratedFileFromPath } from "./storage";

const API = "https://api.pexels.com/v1";
const MAX_LINES = 150; // keeps a run well under the 200 requests/hour limit
const OPTIONS_PER_LINE = 4;
const PHOTO_SECONDS = 6;

type StockProvider = "pixabay" | "pexels";

export function stockProvider(): StockProvider | null {
  if (env("PIXABAY_API_KEY")) return "pixabay";
  if (env("PEXELS_API_KEY")) return "pexels";
  return null;
}
export const stockConfigured = () => !!stockProvider();
export const stockProviderName = () => ({ pixabay: "Pixabay", pexels: "Pexels" } as const)[stockProvider() ?? "pixabay"];
const SETUP_HINT = "Stock clips need a free Pixabay API key: sign up at pixabay.com, copy your key from pixabay.com/api/docs, add PIXABAY_API_KEY=… to .env.local, then restart Wonderboy.";
const framesDir = (projectId: string) => path.join(projectCacheDir(projectId), "frames");

function requireProvider(): StockProvider {
  const p = stockProvider();
  if (!p) throw new ProviderError(SETUP_HINT, 400);
  return p;
}

function requireKey(): string {
  const key = env("PEXELS_API_KEY");
  if (!key) throw new ProviderError(SETUP_HINT, 400);
  return key;
}

/* ------------------------------------------------------------ Pixabay API */

interface PixabayRendition { url?: string; width?: number; height?: number; size?: number; thumbnail?: string }
interface PixabayVideo { id: number; pageURL: string; tags?: string; duration: number; videos?: Record<"large" | "medium" | "small" | "tiny", PixabayRendition>; user?: string; user_id?: number }
interface PixabayImage { id: number; pageURL: string; tags?: string; webformatURL?: string; largeImageURL?: string; imageWidth: number; imageHeight: number; user?: string; user_id?: number }

const PIXABAY_CACHE_MS = 24 * 60 * 60_000; // Pixabay requires caching search results for 24 hours

async function pixabay<T>(pathAndQuery: string, useCache = true): Promise<T> {
  const key = env("PIXABAY_API_KEY");
  if (!key) throw new ProviderError(SETUP_HINT, 400);
  const cacheFile = path.join(dataRoot(), "cache", "pixabay", `${createHash("sha1").update(pathAndQuery).digest("hex")}.json`);
  if (useCache) {
    try {
      const st = await fs.stat(cacheFile);
      if (Date.now() - st.mtimeMs < PIXABAY_CACHE_MS) return JSON.parse(await fs.readFile(cacheFile, "utf8")) as T;
    } catch { /* not cached */ }
  }
  let res: Response;
  try {
    res = await fetch(`https://pixabay.com/api/${pathAndQuery}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  } catch (e) {
    throw new ProviderError(`Could not reach Pixabay: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  const text = await res.text();
  if (res.status === 429) throw new ProviderError("Pixabay's limit was reached (100 searches per minute). Wait a minute, then press the button again: clips already found are kept.", 429);
  if (!res.ok) throw explainHttpError("Pixabay", res.status === 400 && /key/i.test(text) ? 401 : res.status, text.slice(0, 300));
  let data: T;
  try { data = JSON.parse(text) as T; } catch { throw new ProviderError("Pixabay returned an unexpected answer.", 502); }
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, text).catch(() => {});
  return data;
}

/** 1920×1080 ("medium") when available, else 1280×720 ("small"). */
function pixabayFile(v: PixabayVideo): PixabayRendition | null {
  const r = v.videos;
  for (const k of ["medium", "small", "tiny"] as const) if (r?.[k]?.url && (r[k].width ?? 0) <= 1920) return r[k];
  return null;
}
const pixabayUserUrl = (user?: string, id?: number) => (user && id ? `https://pixabay.com/users/${encodeURIComponent(user)}-${id}/` : "https://pixabay.com/");

async function searchPixabay(query: string, kind: "video" | "photo", secondsNeeded: number, exclude: Set<string>): Promise<{ option: Omit<StockOption, "thumb">; thumb: string }[]> {
  const q = encodeURIComponent(query.trim().slice(0, 100));
  const out: { option: Omit<StockOption, "thumb">; thumb: string }[] = [];
  if (kind === "video") {
    const r = await pixabay<{ hits?: PixabayVideo[] }>(`videos/?q=${q}&video_type=film&min_width=1280&safesearch=true&per_page=20&lang=en`);
    const hits = (r.hits ?? []).map(v => ({ v, f: pixabayFile(v) }))
      .filter(({ v, f }) => f && !exclude.has(`pixabay-video-${v.id}`) && (f.width ?? 0) >= 1.3 * (f.height ?? 1)) // landscape only
      .sort((a, b) => Number(b.v.duration >= secondsNeeded) - Number(a.v.duration >= secondsNeeded));
    for (const { v, f } of hits.slice(0, OPTIONS_PER_LINE)) {
      out.push({
        option: { id: `pixabay-video-${v.id}`, kind: "video", duration: v.duration, width: f!.width ?? 0, height: f!.height ?? 0, pageUrl: v.pageURL, author: v.user ?? "Pixabay", authorUrl: pixabayUserUrl(v.user, v.user_id), fileUrl: f!.url!, query },
        thumb: v.videos?.tiny?.thumbnail || f!.thumbnail || "",
      });
    }
  }
  if (kind === "photo" || out.length === 0) {
    const r = await pixabay<{ hits?: PixabayImage[] }>(`?q=${q}&image_type=photo&orientation=horizontal&min_width=1280&safesearch=true&per_page=10&lang=en`);
    for (const p of (r.hits ?? []).filter(x => !exclude.has(`pixabay-photo-${x.id}`) && x.largeImageURL).slice(0, OPTIONS_PER_LINE - out.length)) {
      out.push({
        option: { id: `pixabay-photo-${p.id}`, kind: "photo", duration: 0, width: p.imageWidth, height: p.imageHeight, pageUrl: p.pageURL, author: p.user ?? "Pixabay", authorUrl: pixabayUserUrl(p.user, p.user_id), fileUrl: p.largeImageURL!, query },
        thumb: p.webformatURL || p.largeImageURL!,
      });
    }
  }
  return out.filter(o => o.thumb);
}

/** A fresh download link by id (Pixabay image links expire after 24 hours). */
async function refreshPixabay(option: StockOption): Promise<string> {
  const id = encodeURIComponent(option.id.split("-").pop() ?? "");
  if (option.kind === "video") {
    const r = await pixabay<{ hits?: PixabayVideo[] }>(`videos/?id=${id}`, false);
    return (r.hits?.[0] && pixabayFile(r.hits[0])?.url) || option.fileUrl;
  }
  const r = await pixabay<{ hits?: PixabayImage[] }>(`?id=${id}`, false);
  return r.hits?.[0]?.largeImageURL || option.fileUrl;
}

/* ------------------------------------------------------------- Pexels API */

interface PexelsVideo {
  id: number; width: number; height: number; duration: number; url: string; image: string;
  user?: { name?: string; url?: string };
  video_files?: { quality?: string; file_type?: string; width?: number | null; height?: number | null; link?: string }[];
}
interface PexelsPhoto {
  id: number; width: number; height: number; url: string; photographer?: string; photographer_url?: string; alt?: string;
  src?: Record<string, string>;
}

async function pexels<T>(pathAndQuery: string): Promise<T> {
  const key = requireKey();
  let res: Response;
  try {
    res = await fetch(`${API}${pathAndQuery}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(30_000), cache: "no-store" });
  } catch (e) {
    throw new ProviderError(`Could not reach Pexels: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  if (res.status === 429) throw new ProviderError("Pexels' free limit was reached (200 searches per hour). Wait a while, then press the button again: clips already found are kept.", 429);
  if (!res.ok) throw explainHttpError("Pexels", res.status, errorDetail(await res.text()));
  return (await res.json()) as T;
}

/** Best MP4 for a 1080p render: the widest file up to 1920 px, else the smallest larger one. */
function pickFile(v: PexelsVideo): string {
  const mp4 = (v.video_files ?? []).filter(f => f.file_type === "video/mp4" && f.link && f.width);
  const fit = mp4.filter(f => f.width! <= 1920).sort((a, b) => b.width! - a.width!)[0]
    ?? mp4.sort((a, b) => a.width! - b.width!)[0];
  return fit?.link ?? "";
}

const ALLOWED_HOSTS = /(^|\.)(pixabay\.com|pexels\.com|vimeo\.com|vimeocdn\.com|akamaized\.net)$/i;
function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

async function download(url: string, dest: string, expect: "video" | "image", maxBytes: number): Promise<void> {
  if (!allowedUrl(url)) throw new ProviderError("Refusing to download from an unexpected address.", 400);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  } catch (e) {
    throw new ProviderError(`Download failed: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body) throw new ProviderError(`Download failed (${res.status}).`, 502);
  if (!type.startsWith(`${expect}/`) && !type.startsWith("application/octet-stream")) throw new ProviderError(`Expected ${expect}, got ${type || "unknown"}.`, 502);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new ProviderError("The file is too large.", 413);
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(dest));
  if ((await fs.stat(dest)).size > maxBytes) { await fs.rm(dest, { force: true }); throw new ProviderError("The file is too large.", 413); }
}

async function saveThumb(projectId: string, url: string): Promise<string> {
  await fs.mkdir(framesDir(projectId), { recursive: true });
  const name = `${randomUUID()}.jpg`;
  await download(url, path.join(framesDir(projectId), name), "image", 5_000_000);
  return name;
}

/** Searches the stock provider for a line; downloads thumbnails only. Skips ids in `exclude`. */
export async function searchStock(projectId: string, query: string, kind: "video" | "photo", secondsNeeded: number, exclude: Set<string>): Promise<StockOption[]> {
  if (requireProvider() === "pixabay") {
    const found = await searchPixabay(query, kind, secondsNeeded, exclude);
    const out: StockOption[] = [];
    for (const f of found) {
      try { out.push({ ...f.option, thumb: await saveThumb(projectId, f.thumb) }); } catch { /* skip options whose thumbnail fails */ }
    }
    return out;
  }
  const q = encodeURIComponent(query.trim().slice(0, 100));
  const found: Omit<StockOption, "thumb">[] = [];
  const thumbs: string[] = [];
  if (kind === "video") {
    const r = await pexels<{ videos?: PexelsVideo[] }>(`/videos/search?query=${q}&orientation=landscape&per_page=15&locale=en-US`);
    const videos = (r.videos ?? []).filter(v => !exclude.has(`pexels-video-${v.id}`) && pickFile(v) && v.width >= 1280)
      // Prefer clips long enough for the line, then the closest to 16:9.
      .sort((a, b) => Number(b.duration >= secondsNeeded) - Number(a.duration >= secondsNeeded) || Math.abs(a.width / a.height - 16 / 9) - Math.abs(b.width / b.height - 16 / 9));
    for (const v of videos.slice(0, OPTIONS_PER_LINE)) {
      found.push({ id: `pexels-video-${v.id}`, kind: "video", duration: v.duration, width: v.width, height: v.height, pageUrl: v.url, author: v.user?.name ?? "Pexels", authorUrl: v.user?.url ?? "", fileUrl: pickFile(v), query });
      thumbs.push(v.image);
    }
  }
  if (kind === "photo" || found.length === 0) {
    const r = await pexels<{ photos?: PexelsPhoto[] }>(`/search?query=${q}&orientation=landscape&per_page=10&locale=en-US`);
    for (const p of (r.photos ?? []).filter(x => !exclude.has(`pexels-photo-${x.id}`) && x.src?.large2x).slice(0, OPTIONS_PER_LINE - found.length)) {
      found.push({ id: `pexels-photo-${p.id}`, kind: "photo", duration: 0, width: p.width, height: p.height, pageUrl: p.url, author: p.photographer ?? "Pexels", authorUrl: p.photographer_url ?? "", fileUrl: p.src!.large2x, query });
      thumbs.push(p.src!.medium ?? p.src!.large2x);
    }
  }
  const out: StockOption[] = [];
  for (const [i, o] of found.entries()) {
    try { out.push({ ...o, thumb: await saveThumb(projectId, thumbs[i]) }); } catch { /* skip options whose thumbnail fails */ }
  }
  return out;
}

/** Downloads a chosen option into the project and returns its asset + a segment covering it. */
export async function fetchStock(projectId: string, option: StockOption): Promise<{ asset: Asset; segment: StoryCutSegment }> {
  const provider: StockProvider = option.id.startsWith("pixabay-") ? "pixabay" : "pexels";
  const name = provider === "pixabay" ? "Pixabay" : "Pexels";
  let url = option.fileUrl;
  if (provider === "pixabay") {
    try { url = await refreshPixabay(option); } catch { /* fall back to the stored link */ }
  } else if (option.kind === "video") {
    // Video links are signed and can expire: get a fresh one by id when possible.
    const id = option.id.replace("pexels-video-", "");
    try {
      const v = await pexels<PexelsVideo>(`/videos/videos/${encodeURIComponent(id)}`);
      url = pickFile(v) || url;
    } catch { /* fall back to the stored link */ }
  }
  const dir = path.join(projectCacheDir(projectId), "downloads");
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${randomUUID()}.${option.kind === "video" ? "mp4" : "jpg"}`);
  try {
    await download(url, tmp, option.kind === "video" ? "video" : "image", 400_000_000);
    const asset = await saveGeneratedFileFromPath(projectId, tmp, option.kind === "video" ? "video/mp4" : "image/jpeg", `${name} ${option.kind} ${option.id.split("-").pop()} by ${option.author}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80));
    asset.tags = ["stock", provider];
    asset.notes = `${option.kind === "video" ? "Video" : "Photo"} by ${option.author} on ${name}: ${option.pageUrl} (search: “${option.query}”). ${name} licence: free for commercial use; don't show recognisable people in an offensive or misleading way.`;
    const segment: StoryCutSegment = {
      id: randomUUID(), assetId: asset.id, start: 0, end: option.kind === "video" ? Math.max(1, option.duration) : PHOTO_SECONDS,
      frames: [option.thumb], description: `${option.query} (${name}, ${option.author})`, narration: "", skip: false,
    };
    return { asset, segment };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/* ------------------------------------------------------- planning lines */

interface PlannedLine { text: string; query: string; kind: "video" | "photo" }

const PLAN_SYSTEM = `You prepare a narrated YouTube script for free stock footage.
The script may contain production notes in [brackets] or (parentheses): timestamps, section titles, and the clips/images/scenes the creator wants.
1. Extract only the words the narrator speaks, in order. Split them into lines of one or two sentences, at most MAX_WORDS words each. Keep the wording exactly. Never put notes, timestamps or section titles into the narration.
2. For each line write "query": 2–5 plain English words to search a stock-footage site, describing what is literally visible (e.g. "man spills coffee on shirt"). Use the creator's notes for that part of the script as the main guide.
   Stock sites have no movies, TV shows, cartoons, brands or celebrities: turn any such reference into a generic visual ("Mr. Bean dropping his food" → "man drops food on floor").
3. "type": "photo" only when the notes ask for an image, photo or still; otherwise "video".
4. Vary the queries so neighbouring lines don't show the same thing.
Return JSON only: {"lines":[{"text":"…","query":"…","type":"video"}]}`;

function parseJsonObject(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new ProviderError("The AI's answer wasn't valid JSON. Try again.", 502);
}

const STOP = new Set("a an the and or but of to in on at for with by from his her their its is are was were be been it this that you your i my me we our as so just then very really".split(" "));

/** "The Office Kevin dropping his giant pot of chili" → "dropping giant pot chili" (no titles or names). */
function genericQuery(note: string): string {
  const words = note.replace(/[*"“”]/g, "").split(/\s+/).filter(w => w && !/^[A-Z]/.test(w) && !/^\d/.test(w));
  const kept = words.map(w => w.replace(/[^A-Za-z'-]/g, "")).filter(w => w && !STOP.has(w.toLowerCase()));
  return kept.slice(0, 5).join(" ");
}

function keywords(text: string): string {
  return text.toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).slice(0, 4).join(" ");
}

/** Works without an AI: narration = text outside notes; queries = the section's clip notes in turn. */
export function planWithoutAi(script: string, maxWords: number): PlannedLine[] {
  const lines: PlannedLine[] = [];
  let hints: { query: string; kind: "video" | "photo" }[] = [];
  let next = 0;
  for (const rawPara of script.split(/\n\s*\n|\n/)) {
    const notes = [...rawPara.matchAll(/\[([^\]]*)\]|\(([^)]*)\)/g)].map(m => m[1] ?? m[2] ?? "");
    const clipNotes = notes.map(n => /^\s*(clips?|images?|photos?|scenes?|visuals?|b-?roll|footage)\s*:/i.exec(n) ? n : "").filter(Boolean);
    if (clipNotes.length) {
      hints = clipNotes.flatMap(n => {
        const kind: "video" | "photo" = /^\s*(images?|photos?)/i.test(n) ? "photo" : "video";
        return n.replace(/^[^:]*:/, "").split(/[,;]/).map(x => ({ query: genericQuery(x), kind })).filter(x => x.query);
      });
      next = 0;
    }
    const text = rawPara.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/^\s*title\s*:.*$/i, "").replace(/\s+/g, " ").trim();
    if (!text || /^[A-Z0-9\s:—–-]+$/.test(text)) continue; // empty or a SECTION HEADING
    const sentences = text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [text];
    let cur = "";
    const flush = () => {
      if (!cur.trim()) return;
      const hint = hints.length ? hints[next++ % hints.length] : null;
      lines.push({ text: cur.trim(), query: hint?.query || keywords(cur) || "city street people", kind: hint?.kind ?? "video" });
      cur = "";
    };
    for (const s of sentences) {
      if (countWords(cur + s) > maxWords && cur) flush();
      cur += s;
    }
    flush();
  }
  return lines;
}

async function planLines(script: string, maxWords: number, progress: (m: string) => void): Promise<{ lines: PlannedLine[]; by: string }> {
  if (!activeLlm()) return { lines: planWithoutAi(script, maxWords), by: "the bracket notes (no AI key set)" };
  let r: { text: string; provider: string };
  try {
    r = await chat({ system: PLAN_SYSTEM.replace("MAX_WORDS", String(maxWords)), json: true, maxTokens: 16384, onRetry: progress, messages: [{ role: "user", content: script.slice(0, 30000) }] });
  } catch (e) {
    // The AI is optional here: the bracket notes are enough to search.
    const lines = planWithoutAi(script, maxWords);
    if (!lines.length) throw e;
    return { lines, by: `the bracket notes (the AI was unavailable: ${e instanceof Error ? e.message.split(". ")[0] : "error"})` };
  }
  const data = parseJsonObject(r.text);
  const lines = (Array.isArray(data.lines) ? data.lines as { text?: unknown; query?: unknown; type?: unknown }[] : [])
    .filter(l => typeof l.text === "string" && l.text.trim())
    .map(l => ({
      text: String(l.text).replace(/\s+/g, " ").trim().slice(0, 1000),
      query: typeof l.query === "string" && l.query.trim() ? l.query.trim().slice(0, 100) : keywords(String(l.text)),
      kind: l.type === "photo" ? "photo" as const : "video" as const,
    }));
  if (!lines.length) throw new ProviderError("The AI returned no lines. Try again.", 502);
  return { lines, by: r.provider };
}

/* ------------------------------------------------------------- the job */

export interface StockResult { lines: StoryCutLine[]; segments: StoryCutSegment[]; assets: Asset[]; notes: string }

/**
 * Plans lines from the script, searches each, downloads the top pick.
 * `save` is called after every line so partial results survive a failure (e.g. the hourly limit).
 */
export async function runStockSearch(projectId: string, cut: StoryCut, progress: (m: string) => void, save: (r: StockResult) => Promise<void>): Promise<StockResult> {
  requireProvider();
  progress("Reading your script…");
  const maxWords = Math.max(12, wordBudget(9, cut.voice.speed));
  const plan = await planLines(cut.script, maxWords, progress);
  if (plan.lines.length > MAX_LINES) throw new ProviderError(`The script has ${plan.lines.length} lines; the limit per run is ${MAX_LINES}. Split it into parts.`, 400);

  // Keep clips already chosen for identical lines from an earlier run (no re-download).
  const previous = new Map(cut.lines.filter(l => l.sceneId).map(l => [`${l.text}|${l.query}`, l]));
  const keptSegments = new Map(cut.segments.map(s => [s.id, s]));
  const used = new Set<string>();
  const result: StockResult = { lines: [], segments: [], assets: [], notes: "" };
  let missing = 0;

  for (const [i, p] of plan.lines.entries()) {
    const old = previous.get(`${p.text}|${p.query}`);
    const oldSeg = old?.sceneId ? keptSegments.get(old.sceneId) : undefined;
    if (old && oldSeg) {
      result.lines.push({ ...old, id: randomUUID() });
      result.segments.push(oldSeg);
      for (const o of old.stock) used.add(o.id);
      continue;
    }
    progress(`Line ${i + 1} of ${plan.lines.length}: searching “${p.query}”…`);
    const seconds = countWords(p.text) / (2.4 * cut.voice.speed) + 0.5;
    const options = await searchStock(projectId, p.query, p.kind, seconds, used);
    const line: StoryCutLine = { id: randomUUID(), text: p.text, sceneId: null, options: [], query: p.query, stock: options };
    if (options[0]) {
      used.add(options[0].id);
      progress(`Line ${i + 1} of ${plan.lines.length}: downloading the clip…`);
      const { asset, segment } = await fetchStock(projectId, options[0]);
      result.assets.push(asset);
      result.segments.push(segment);
      line.sceneId = segment.id;
    } else {
      missing++;
    }
    result.lines.push(line);
    result.notes = `${result.lines.length} of ${plan.lines.length} lines done.`;
    await save(result);
  }
  result.notes = `${result.lines.length} lines planned from ${plan.by}; ${result.assets.length} clips downloaded.${missing ? ` ${missing} line${missing > 1 ? "s" : ""} found nothing: search with other words.` : ""} Clips: ${stockProviderName()} (free licence; credits below).`;
  return result;
}

export function secondsFor(text: string, speed: number) {
  return countWords(text) / (2.4 * speed) + 0.5;
}

