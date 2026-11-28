// Story Cuts: scene detection, AI scene description, story writing and rendering.
// Server-only. Jobs run in the background one at a time (this laptop has 8 GB RAM);
// results are stored in storycuts.json and imported into the project by the client.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { nowIso } from "../projectModel";
import { linePiece, segmentLength, speakSeconds, styleById, wordBudget, type StoryDraft, type StoryJob, type StoryJobKind, type StoryJobView } from "../storyCut";
import type { ID, StoryCut, StoryCutLine, StoryCutSegment } from "../types";
import { audioProvider, parseWav } from "./ai/audio";
import { ProviderError } from "./ai/http";
import { activeLlm, chat } from "./ai/llm";
import { fetchStock, runStockSearch, searchStock, secondsFor, stockConfigured } from "./stock";
import { detectScenes, extractFrame, extractFramesEvery, mediaTools, probe, renderParts, type Probe, type RenderPart } from "./media";
import { processState } from "./processState";
import { findFile, isValidId, projectCacheDir, readProject, readSideFile, saveGeneratedFileFromPath, StorageError, updateSideFile } from "./storage";

const MAX_RECORDS = 40;
const MAX_SCENES = 400;
const DESCRIBE_BATCH = 10;

const active = processState("storyJobs", () => new Map<ID, string>()); // job id → progress message
const queue = processState("storyQueue", () => ({ chain: Promise.resolve() as Promise<unknown> })); // one job at a time

const bad = (msg: string, status = 400): never => { throw new ProviderError(msg, status); };
const framesDir = (projectId: string) => path.join(projectCacheDir(projectId), "frames");
export const FRAME_NAME = /^[A-Za-z0-9_-]{1,80}\.jpg$/;

export function framePath(projectId: string, name: string): string | null {
  return FRAME_NAME.test(name) ? path.join(framesDir(projectId), name) : null;
}

const stillQueue = processState("stillQueue", () => ({ chain: Promise.resolve() as Promise<unknown> })); // one ffmpeg at a time

/**
 * A frame of a footage video at `time` seconds (rounded to 0.1 s), cached in the frames folder.
 * Used for the picture of each script line, so it shows where the line's piece starts.
 */
export async function stillFrame(projectId: string, assetId: string, time: number): Promise<string> {
  if (!isValidId(assetId) || !isFinite(time) || time < 0 || time > 86_400) bad("Invalid frame request.");
  const tenths = Math.round(time * 10);
  const file = framePath(projectId, `still-${assetId}-${tenths}.jpg`);
  if (!file) bad("Invalid frame request.");
  if (existsSync(file!)) return file!;
  const run = stillQueue.chain.then(async () => {
    if (existsSync(file!)) return;
    const src = await findFile(projectId, assetId);
    if (!src) throw new ProviderError("That video is no longer in the project.", 404);
    await fs.mkdir(framesDir(projectId), { recursive: true });
    await extractFrame(src.filePath, tenths / 10, file!);
  });
  stillQueue.chain = run.catch(() => {});
  await run;
  return file!;
}

async function patch(projectId: string, id: ID, changes: Partial<StoryJob>) {
  await updateSideFile<StoryJob[]>(projectId, "storycuts", [], list => list.map(j => (j.id === id ? { ...j, ...changes } : j)));
}

export async function listStoryJobs(projectId: string): Promise<StoryJobView[]> {
  const list = await readSideFile<StoryJob[]>(projectId, "storycuts", []);
  const stale = list.filter(j => j.status === "running" && !active.has(j.id));
  if (stale.length) {
    const msg = "Stopped because the Wonderboy server was closed or restarted. Press Resume to continue where it left off.";
    await updateSideFile<StoryJob[]>(projectId, "storycuts", [], cur => cur.map(j => (stale.some(s => s.id === j.id) ? { ...j, status: "failed", error: msg, finishedAt: nowIso() } : j)));
    for (const j of stale) Object.assign(j, { status: "failed", error: msg });
  }
  return list.map(j => ({ ...j, progress: active.get(j.id) ?? null }));
}

async function loadCut(projectId: string, cutId: string): Promise<StoryCut> {
  const project = await readProject(projectId);
  const cut = project.storyCuts.find(c => c.id === cutId);
  if (!cut) bad("Story cut not found. Wait for the project to save and try again.", 404);
  return cut!;
}

/** Validates and queues a background job. */
export async function startStoryJob(projectId: string, body: { kind?: unknown; cutId?: unknown; overwrite?: unknown; sensitivity?: unknown; rescan?: unknown; resume?: unknown }): Promise<StoryJob> {
  const kind = body.kind as StoryJobKind;
  if (!["detect", "describe", "render", "auto", "stock", "check"].includes(kind)) bad("kind must be detect, describe, render, auto, stock or check.");
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  if (kind !== "describe" && kind !== "stock") { const t = await mediaTools(); if (!t.ok) bad(t.error!); }
  if (kind === "stock") {
    if (!cut.script.trim()) bad("Paste your script first.");
    if (!stockConfigured()) bad("Stock clips need a free Pixabay API key: sign up at pixabay.com, copy your key from pixabay.com/api/docs, add PIXABAY_API_KEY=… to .env.local, then restart Wonderboy.");
  }
  if ((kind === "detect" || kind === "auto") && !cut.sources.length) bad("Add your film (or clips) first.");
  if (kind === "auto") {
    if (!cut.script.trim()) bad("Paste your script first.");
    if (!activeLlm()) bad("Finding clips needs the AI. Set GEMINI_API_KEY in .env.local (free at aistudio.google.com), then restart Wonderboy.");
  }
  if (kind === "check") {
    if (cut.mode !== "script") bad("Checking clips works on your own footage (script mode).");
    if (!cut.lines.some(l => l.sceneId && l.text.trim())) bad("No line has a clip to check yet. Find clips for your script first.");
    if (!activeLlm()) bad("Checking clips needs the AI. Set GEMINI_API_KEY in .env.local (free at aistudio.google.com), then restart Wonderboy.");
  }
  if (kind === "describe") {
    if (!cut.segments.some(s => s.frames.length)) bad("Detect scenes first.");
    if (!activeLlm()) bad("Describing scenes needs an AI text model that can see images. Set GEMINI_API_KEY in .env.local (free tier) and restart.");
  }
  if (kind === "render") {
    const clips = clipsFor(cut);
    if (!clips.length) bad(cut.mode === "story" ? "There are no scenes to render." : "No line has a clip yet. Find clips for your script first.");
    const p = audioProvider(cut.voice.providerId);
    if (!p) bad("Choose a voice engine.");
    const info = p!.info();
    if (clips.some(c => c.narration)) {
      if (!info.configured) bad(`${info.label} is not configured: ${info.setup}`);
      if (!info.caps.voices.some(v => v.id === cut.voice.voice)) bad("Choose a voice.");
    }
  }
  const existing = (await readSideFile<StoryJob[]>(projectId, "storycuts", [])).find(j => j.status === "running" && j.cutId === cut.id && j.kind === kind && active.has(j.id));
  if (existing) bad("This step is already running for this story.", 409);
  if (kind === "auto" || kind === "detect" || kind === "describe" || kind === "check") {
    const busyCut = (await readSideFile<StoryJob[]>(projectId, "storycuts", [])).find(j => j.status === "running" && j.cutId === cut.id && j.kind !== "render" && active.has(j.id));
    if (busyCut) bad("Another step is still working on this story. Wait for it to finish.", 409);
  }

  const job: StoryJob = {
    id: randomUUID(), kind, cutId: cut.id, cutTitle: cut.title, status: "running", error: null, notes: "", createdAt: nowIso(), finishedAt: null,
  };
  await updateSideFile<StoryJob[]>(projectId, "storycuts", [], cur => [job, ...cur].slice(0, MAX_RECORDS));
  active.set(job.id, "Waiting for the previous job to finish…");
  const sensitivity = typeof body.sensitivity === "number" ? Math.min(0.6, Math.max(0.1, body.sensitivity)) : 0.3;
  const overwrite = body.overwrite === true;
  const rescan = body.rescan === true;
  const resume = body.resume === true;

  queue.chain = queue.chain.then(async () => {
    const progress = (m: string) => active.set(job.id, m);
    try {
      const fresh = await loadCut(projectId, cut.id).catch(() => cut);
      if (kind === "detect") await runDetect(projectId, fresh, job, sensitivity, progress);
      if (kind === "describe") await runDescribe(projectId, fresh, job, overwrite, progress);
      if (kind === "render") await runRender(projectId, fresh, job, progress);
      if (kind === "check") await runCheck(projectId, fresh, job, resume, progress);
      if (kind === "auto") await runAuto(projectId, fresh, job, sensitivity, rescan, progress);
      if (kind === "stock") {
        const r = await runStockSearch(projectId, fresh, progress, part => patch(projectId, job.id, { lines: part.lines, segments: part.segments, assets: part.assets, notes: part.notes }));
        await patch(projectId, job.id, { status: "succeeded", lines: r.lines, segments: r.segments, assets: r.assets, notes: r.notes, finishedAt: nowIso() });
      }
    } catch (e) {
      const message = e instanceof ProviderError || e instanceof StorageError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      if (!(e instanceof ProviderError)) console.error(e);
      await patch(projectId, job.id, { status: "failed", error: message, finishedAt: nowIso() }).catch(() => {});
    } finally {
      active.delete(job.id);
    }
  });
  return job;
}

/* ---------------------------------------------------------------- detect */

async function runDetect(projectId: string, cut: StoryCut, job: StoryJob, sensitivity: number, progress: (m: string) => void) {
  const segments = await detectSegments(projectId, cut, sensitivity, progress);
  const total = segments.reduce((n, s) => n + segmentLength(s), 0);
  await patch(projectId, job.id, { status: "succeeded", segments, notes: `${segments.length} scenes, ${Math.round(total)} s of footage.`, finishedAt: nowIso() });
}

/** Finds scenes in the cut's sources and saves keyframes. Deletes the cut's old keyframes. */
async function detectSegments(projectId: string, cut: StoryCut, sensitivity: number, progress: (m: string) => void, totalSources = cut.sources.length): Promise<StoryCutSegment[]> {
  // Higher "sensitivity" in the UI = more cuts = lower ffmpeg scene threshold.
  const threshold = Math.round((0.7 - sensitivity) * 100) / 100;
  const found: (StoryCutSegment & { file: string })[] = [];
  // Each video gets a fair share of the scene limit, so one busy video (a meme compilation) can't crowd out the rest.
  const perVideo = Math.max(15, Math.floor(MAX_SCENES / Math.max(1, totalSources)));
  const seen = new Set<string>();
  for (const [i, src] of cut.sources.entries()) {
    const f = await findFile(projectId, src.assetId);
    if (!f) bad("A footage file is missing from the project.");
    const pr = await probe(f!.filePath);
    const st = await fs.stat(f!.filePath);
    const same = `${st.size}:${src.start ?? ""}:${src.end ?? ""}`;
    if (seen.has(same)) continue; // the same file added twice
    seen.add(same);
    const start = Math.min(Math.max(0, src.start ?? 0), Math.max(0, pr.duration - 1));
    const end = src.end && src.end > start + 1 ? Math.min(src.end, pr.duration) : pr.duration;
    const label = cut.sources.length > 1 ? ` (video ${i + 1} of ${cut.sources.length})` : "";
    let scenes = await detectScenes(f!.filePath, start, end, threshold, frac => progress(`Finding scenes${label}… ${Math.round(frac * 100)}%`));
    // Too many: keep the longest ones (more usable under a voice line), in film order.
    if (scenes.length > perVideo) scenes = [...scenes].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, perVideo).sort((a, b) => a.start - b.start);
    for (const s of scenes) found.push({ id: randomUUID(), assetId: src.assetId, start: s.start, end: s.end, frames: [], description: "", narration: "", skip: false, file: f!.filePath });
    if (found.length > MAX_SCENES) bad(`Found more than ${MAX_SCENES} scenes. Set a shorter start/end range, or lower the sensitivity.`);
  }

  await fs.mkdir(framesDir(projectId), { recursive: true });
  for (const [i, s] of found.entries()) {
    progress(`Saving keyframes… ${i + 1} of ${found.length}`);
    const len = segmentLength(s);
    const times = len < 3 ? [s.start + len / 2] : [s.start + len * 0.3, s.start + len * 0.7];
    for (const t of times) {
      const name = `${randomUUID()}.jpg`;
      await extractFrame(s.file, t, path.join(framesDir(projectId), name));
      s.frames.push(name);
    }
  }
  const segments: StoryCutSegment[] = found.map(s => ({ id: s.id, assetId: s.assetId, start: s.start, end: s.end, frames: s.frames, description: "", narration: "", skip: false }));
  // Old keyframes of this cut are no longer referenced once the client imports the new scenes.
  for (const s of cut.segments) for (const fr of s.frames) { const p = framePath(projectId, fr); if (p) await fs.rm(p, { force: true }); }
  return segments;
}

/* -------------------------------------------------------------- describe */

function parseJsonObject(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new ProviderError("The AI's answer wasn't valid JSON. Try again.", 502);
}

const DESCRIBE_SYSTEM = `You describe scenes of video footage for a narrator who will write a NEW, original story over them.
For each scene you get 1–2 still frames. In 1–3 plain sentences describe what a viewer sees:
- the people: apparent age range, gender presentation, expression and emotion, clothing, what they do, how they relate to each other;
- the setting, time of day, weather, mood, and the framing (close-up, wide, etc.);
- if the two frames differ, what changes.
Never identify real people, actors or the film. Refer to people by appearance ("a young woman in a white dress"); when the same-looking person appears again, use the same description so the writer can tell it's the same person.
Return JSON only: {"scenes":[{"scene":<number>,"description":"…"}]}`;

async function runDescribe(projectId: string, cut: StoryCut, job: StoryJob, overwrite: boolean, progress: (m: string) => void) {
  const r = await describeSegments(projectId, cut.segments, overwrite, progress, d => patch(projectId, job.id, { descriptions: d }));
  if (r.targets === 0) {
    await patch(projectId, job.id, { status: "succeeded", descriptions: {}, notes: "Every scene already has a description.", finishedAt: nowIso() });
    return;
  }
  const n = Object.keys(r.descriptions).length;
  const missed = r.targets - n;
  await patch(projectId, job.id, {
    status: "succeeded", descriptions: r.descriptions, finishedAt: nowIso(),
    notes: `Described ${n} scenes with ${r.provider}.${missed ? ` ${missed} came back empty; describe them yourself or run again.` : ""}`,
  });
}

/** Describes scenes without a description (or all, with `overwrite`) from their keyframes, in batches. */
async function describeSegments(projectId: string, segments: StoryCutSegment[], overwrite: boolean, progress: (m: string) => void, onBatch: (d: Record<ID, string>) => Promise<void>): Promise<{ descriptions: Record<ID, string>; provider: string; targets: number }> {
  const targets = segments.filter(s => s.frames.length && (overwrite || !s.description.trim()));
  if (!targets.length) return { descriptions: {}, provider: "", targets: 0 };
  const descriptions: Record<ID, string> = {};
  const batches = Math.ceil(targets.length / DESCRIBE_BATCH);
  let provider = "";
  try {
    for (let b = 0; b < batches; b++) {
      const batch = targets.slice(b * DESCRIBE_BATCH, (b + 1) * DESCRIBE_BATCH);
      progress(`Looking at scenes ${b * DESCRIBE_BATCH + 1}–${b * DESCRIBE_BATCH + batch.length} of ${targets.length}…`);
      const images: { mimeType: string; data: string }[] = [];
      const lines: string[] = [];
      for (const [i, s] of batch.entries()) {
        const first = images.length + 1;
        for (const fr of s.frames) {
          const p = framePath(projectId, fr);
          if (p && existsSync(p)) images.push({ mimeType: "image/jpeg", data: (await fs.readFile(p)).toString("base64") });
        }
        const n = images.length - first + 1;
        lines.push(`Scene ${i + 1} (${segmentLength(s).toFixed(1)} s): ${n ? `image${n > 1 ? "s" : ""} ${first}${n > 1 ? `–${images.length}` : ""}` : "no image"}`);
      }
      const r = await chat({
        system: DESCRIBE_SYSTEM, json: true, maxTokens: 4096, onRetry: progress,
        messages: [{ role: "user", content: `The images below are in order.\n${lines.join("\n")}\n\nDescribe scenes 1–${batch.length}.`, images }],
      });
      provider = r.provider;
      const data = parseJsonObject(r.text);
      const scenes = Array.isArray(data.scenes) ? data.scenes as { scene?: unknown; description?: unknown }[] : [];
      for (const sc of scenes) {
        const idx = Number(sc.scene) - 1;
        if (batch[idx] && typeof sc.description === "string" && sc.description.trim()) descriptions[batch[idx].id] = sc.description.trim().slice(0, 800);
      }
      await onBatch({ ...descriptions });
    }
  } catch (e) {
    if (Object.keys(descriptions).length) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`${msg} (${Object.keys(descriptions).length} of ${targets.length} scenes were described and kept; run it again to continue.)`, 502);
    }
    throw e;
  }
  return { descriptions, provider, targets: targets.length };
}

/* ----------------------------------------------------------------- story */

const STORY_SYSTEM = `You write voiceover narration for short YouTube story videos made from existing footage (stock clips and public-domain films).
Rules:
- Write a NEW, ORIGINAL story. Never retell, explain or mention the source film, its actors, or that this is footage.
- The people on screen become your characters. Give them names. Use the scene descriptions to keep each person consistent: the same-looking person is the same character.
- Each scene's narration must fit what is on screen at that moment (who is visible, what they do, the mood), so the pictures feel like they illustrate the story.
- Respect each scene's word budget: never exceed it. Narration may be shorter, or empty ("") to let a picture breathe. You may set "skip": true for scenes that don't fit the story at all (keep most scenes).
- Open with a strong hook in the first scene. Build tension. End with a satisfying ending, twist or moral.
- Plain spoken English for text-to-speech: short sentences, no stage directions, no emojis, no headings, no quotation of on-screen text.
Return JSON only: {"title":"…","summary":"one-sentence logline","segments":[{"scene":<number>,"narration":"…","skip":false}]}`;

export async function writeStory(projectId: string, body: { cutId?: unknown; style?: unknown; instructions?: unknown }): Promise<StoryDraft & { provider: string }> {
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  if (!activeLlm()) bad("Writing the story needs an AI text model. Set GEMINI_API_KEY in .env.local (free tier) and restart.");
  if (!cut.segments.length) bad("Detect scenes first.");
  if (!cut.segments.some(s => s.description.trim())) bad("Describe the scenes first (step 2), or type short descriptions yourself, so the story can match the pictures.");
  const style = styleById(typeof body.style === "string" ? body.style : cut.style);
  const instructions = (typeof body.instructions === "string" ? body.instructions : cut.instructions).trim().slice(0, 2000);
  if (style.id === "custom" && !instructions) bad("Write your story instructions, or choose a style.");

  const scenes = cut.segments.map((s, i) => {
    const len = segmentLength(s);
    return `Scene ${i + 1} (${len.toFixed(1)} s, budget ${wordBudget(len, cut.voice.speed)} words)${s.skip ? " [currently skipped]" : ""}: ${s.description.trim() || "(no description; keep narration general or empty)"}`;
  });
  const totalWords = cut.segments.filter(s => !s.skip).reduce((n, s) => n + wordBudget(segmentLength(s), cut.voice.speed), 0);
  const prompt = [
    `Story style: ${style.prompt || "(see instructions)"}`,
    instructions ? `Extra instructions from the creator: ${instructions}` : "",
    `There are ${cut.segments.length} scenes in this order (total budget about ${totalWords} words):`,
    scenes.join("\n"),
  ].filter(Boolean).join("\n\n");

  const r = await chat({ system: STORY_SYSTEM, json: true, maxTokens: 8192, messages: [{ role: "user", content: prompt }] });
  const data = parseJsonObject(r.text);
  const narrations: Record<ID, string> = {};
  const skips: ID[] = [];
  for (const sg of Array.isArray(data.segments) ? data.segments as { scene?: unknown; narration?: unknown; skip?: unknown }[] : []) {
    const seg = cut.segments[Number(sg.scene) - 1];
    if (!seg) continue;
    narrations[seg.id] = typeof sg.narration === "string" ? sg.narration.replace(/\s+/g, " ").trim().slice(0, 2000) : "";
    if (sg.skip === true) skips.push(seg.id);
  }
  if (!Object.keys(narrations).length) bad("The AI returned no narration. Try again.", 502);
  return {
    title: typeof data.title === "string" ? data.title.trim().slice(0, 120) : "",
    summary: typeof data.summary === "string" ? data.summary.trim().slice(0, 400) : "",
    narrations, skips, provider: r.provider,
  };
}


/* ----------------------------------------------------------- script mode */

/** 1-based video number of each source (in the order the user added them). */
function videoNumbers(cut: StoryCut): Map<ID, number> {
  return new Map(cut.sources.map((s, i) => [s.assetId, i + 1]));
}

/** Mixing applies only with more than one video that actually has scenes. */
function mixing(cut: StoryCut): boolean {
  return cut.mix && new Set(cut.segments.map(s => s.assetId)).size > 1;
}

function sceneCatalogue(cut: StoryCut): string {
  const vid = videoNumbers(cut);
  const multi = cut.sources.length > 1;
  return cut.segments.map((s, i) => `Scene ${i + 1}${multi ? ` [video ${vid.get(s.assetId) ?? "?"}]` : ""} (${segmentLength(s).toFixed(1)} s): ${s.description.trim() || "(no description)"}`).join("\n");
}

function requireScriptInputs(cut: StoryCut) {
  if (!activeLlm()) bad("This needs an AI text model. Set GEMINI_API_KEY in .env.local (free tier) and restart.");
  if (!cut.script.trim()) bad("Paste your script first.");
  if (!cut.segments.length) bad("Detect scenes first.");
  if (!cut.segments.some(s => s.description.trim())) bad("Describe the scenes first (step 2), so the AI knows who is in each one.");
}

const CAST_SYSTEM = `You cast a script using people who appear in existing film footage.
You get the script and a numbered list of scene descriptions. Identify the script's main on-screen characters (max 8) and, for each, choose the person in the footage who appears often enough and fits best (age, gender presentation, look, the roles they play in scenes).
Describe that person by their recurring appearance exactly as the scene descriptions do (e.g. "old man in a grey coat"), so they can be found again. Never name real actors.
If nobody in the footage fits a character, set "look" to "" .
Return JSON only: {"cast":[{"name":"…","look":"…"}]}`;

export async function suggestCast(projectId: string, body: { cutId?: unknown }): Promise<{ cast: { name: string; look: string }[]; provider: string }> {
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  requireScriptInputs(cut);
  return castFor(cut);
}

async function castFor(cut: StoryCut, progress?: (m: string) => void): Promise<{ cast: { name: string; look: string }[]; provider: string }> {
  const r = await chat({
    system: CAST_SYSTEM, json: true, maxTokens: 2048, onRetry: progress,
    messages: [{ role: "user", content: `SCRIPT:\n${cut.script.trim().slice(0, 20000)}\n\nFOOTAGE SCENES:\n${sceneCatalogue(cut)}` }],
  });
  const data = parseJsonObject(r.text);
  const cast = (Array.isArray(data.cast) ? data.cast as { name?: unknown; look?: unknown }[] : [])
    .map(m => ({ name: typeof m.name === "string" ? m.name.trim().slice(0, 80) : "", look: typeof m.look === "string" ? m.look.trim().slice(0, 200) : "" }))
    .filter(m => m.name).slice(0, 8);
  if (!cast.length) bad("The AI found no characters in the script. Add the cast yourself.", 502);
  return { cast, provider: r.provider };
}

const MATCH_SYSTEM = `You are a film editor. You illustrate a narrated script with scenes from existing footage.
1. Split the script into narration lines in reading order. Keep the script's own words (fix only obvious typos). Each line is one or two short sentences, at most MAX_WORDS words. Drop headings and stage directions; keep only what the narrator says.
2. For each line, choose up to 3 scenes (by number, best first) that show it: the right character (use the cast's looks), the action, the setting and the mood. When a line names a character, prefer scenes where that character's look is visible. Prefer scenes at least as long as the line takes to speak (about 2.4 words per second).
3. Use each scene as a first choice at most once across all lines, and keep the story's visual flow (avoid jumping between very different places without reason).
Return JSON only: {"lines":[{"text":"…","scenes":[<n>,<n>,<n>]}]}`;

const MIX_RULES = `
MIXING (most important): the footage comes from VIDEOS different videos, marked [video N]. The finished film must use all of them about equally: each video for roughly 1 in VIDEOS lines, and never the same video for more than 2 lines in a row. Variety matters more than a perfect match or the same face: a character may be shown by different people in different videos. For each line give up to 5 scenes, taken from at least 2 different videos.`;

export async function matchScript(projectId: string, body: { cutId?: unknown }): Promise<{ lines: StoryCutLine[]; notes: string; provider: string }> {
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  requireScriptInputs(cut);
  return matchFor(cut);
}

/**
 * The model doesn't always answer with bare numbers: with "[video N]" labels in the list it may
 * write "Scene 12", "12 [video 3]", "video 3, scene 12" or {"scene":12,"video":3}. Take the scene number.
 */
function sceneNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.match(/scene\s*#?\s*(\d+)/i) ?? v.replace(/\[?video\s*\d+\]?/gi, "").match(/\d+/);
    return m ? Number(m[1] ?? m[0]) : NaN;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return sceneNumber(o.scene ?? o.number ?? o.n ?? o.id ?? o.index);
  }
  return NaN;
}

async function matchFor(cut: StoryCut, progress?: (m: string) => void): Promise<{ lines: StoryCutLine[]; notes: string; provider: string }> {
  const lengths = cut.segments.map(segmentLength).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 5;
  const maxWords = Math.min(30, Math.max(10, wordBudget(median * 1.6, cut.voice.speed)));
  const mix = mixing(cut);
  const videos = new Set(cut.segments.map(s => s.assetId)).size;
  const cast = cut.cast.filter(m => m.name.trim());
  const prompt = [
    cast.length ? `CAST (character = person in the footage${mix ? "; a soft preference only, variety comes first" : ""}):\n${cast.map(m => `${m.name} = ${m.look || "(not in the footage)"}`).join("\n")}` : "CAST: not given; infer who is who from the descriptions.",
    `SCRIPT:\n${cut.script.trim().slice(0, 20000)}`,
    `FOOTAGE SCENES:\n${sceneCatalogue(cut)}`,
  ].join("\n\n");
  const system = MATCH_SYSTEM.replace("MAX_WORDS", String(maxWords)) + (mix ? MIX_RULES.replace(/VIDEOS/g, String(videos)) : "");
  const r = await chat({ system, json: true, maxTokens: 16384, onRetry: progress, messages: [{ role: "user", content: prompt }] });
  const data = parseJsonObject(r.text);
  const raw = (Array.isArray(data.lines) ? data.lines as { text?: unknown; scenes?: unknown; scene?: unknown }[] : [])
    .filter(l => typeof l.text === "string" && l.text.trim()).slice(0, 500);
  if (!raw.length) bad("The AI returned no lines. Try again.", 502);

  const segById = new Map(cut.segments.map(s => [s.id, s]));
  const used = new Set<ID>();
  const perVideo = new Map<ID, number>();
  const cap = Math.ceil(raw.length / Math.max(1, videos)) + 1; // fair share per video, plus one
  let unmatched = 0;
  let reassigned = 0;
  let noSuggestions = 0;
  let previous: ID | null = null;

  const lines: StoryCutLine[] = raw.map(l => {
    const picks = Array.isArray(l.scenes) ? l.scenes : l.scenes != null ? [l.scenes] : l.scene != null ? [l.scene] : [];
    let options = [...new Set(picks.map(n => cut.segments[sceneNumber(n) - 1]?.id).filter((x): x is ID => !!x))].slice(0, mix ? 5 : 3);
    if (!options.length) noSuggestions++;
    const free = options.filter(o => !used.has(o));
    let sceneId: ID | null = free[0] ?? null;
    if (mix) {
      // Among the AI's suggestions, prefer the least-used video (AI order breaks ties), avoiding the previous line's video.
      const score = (o: ID) => { const a = segById.get(o)!.assetId; return (perVideo.get(a) ?? 0) * 2 + (a === previous ? 1 : 0); };
      sceneId = [...free].sort((a, b) => score(a) - score(b))[0] ?? null;
      const least = Math.min(...[...new Set(cut.segments.map(s => s.assetId))].map(a => perVideo.get(a) ?? 0));
      // A little slack (least + 2) so a good match wins over strict rotation; the cap still keeps it fair.
      const overused = (id: ID | null) => { const n = id ? perVideo.get(segById.get(id)!.assetId) ?? 0 : Infinity; return n >= cap || n > least + 2; };
      if (overused(sceneId)) {
        // Every suggestion is from an overused video (or none is left): take an unused scene from the least-used video, at random.
        const counts = [...new Set(cut.segments.map(s => s.assetId))].map(a => ({ a, n: perVideo.get(a) ?? 0 })).sort((x, y) => x.n - y.n);
        for (const { a } of counts) {
          const pool = cut.segments.filter(s => s.assetId === a && !used.has(s.id) && s.assetId !== previous);
          if (pool.length) { sceneId = pool[Math.floor(Math.random() * pool.length)].id; reassigned++; break; }
        }
        if (sceneId && !options.includes(sceneId)) options = [sceneId, ...options].slice(0, 5);
      }
    }
    if (sceneId) {
      used.add(sceneId);
      const a = segById.get(sceneId)!.assetId;
      perVideo.set(a, (perVideo.get(a) ?? 0) + 1);
      previous = a;
    } else unmatched++;
    return { id: randomUUID(), text: String(l.text).replace(/\s+/g, " ").trim().slice(0, 1000), sceneId, options, offset: 0, fit: "" as const, query: "", stock: [] };
  });

  const vid = videoNumbers(cut);
  const spread = cut.sources.length > 1
    ? ` Clips per video: ${cut.sources.map(s => `video ${vid.get(s.assetId)}: ${perVideo.get(s.assetId) ?? 0}`).join(", ")}.${reassigned ? ` ${reassigned} picked at random from less-used videos to keep the mix even: check they fit.` : ""}`
    : "";
  return {
    lines, provider: r.provider,
    notes: `${lines.length} lines, ${lines.length - unmatched} with a scene.${unmatched ? ` ${unmatched} need a scene: pick one yourself.` : ""}${noSuggestions ? ` The AI suggested no usable scene for ${noSuggestions} line${noSuggestions === 1 ? "" : "s"}.` : ""}${spread}`,
  };
}

/* ------------------------------------------- visual check (script mode) */

const CHECK_BATCH = 3; // lines per AI call
const CHECK_CANDIDATES = 3; // scenes looked at per line
const CHECK_STEP = 1.5; // about one frame per this many seconds of scene
const CHECK_MAX_FRAMES = 6;

const CHECK_SYSTEM = `You are a film editor choosing the exact shot for each line of a narrated video.
For each LINE you see still frames from up to ${CHECK_CANDIDATES} candidate clips, lettered A, B, C. Each frame is labelled with its time in seconds from the clip's start.
For each line:
- "pick": the candidate whose pictures best show what the line says or feels (the action, reaction, emotion, setting or mood). A literal match is best; a clear emotional match is fine.
- "start": the time in seconds where the best moment begins. The narrator needs the stated number of seconds, so the piece shown runs from start to start + that length.
- "fit": "good" = the pictures clearly show the line; "loose" = only the mood or idea fits; "poor" = none of the candidates fits.
Judge only what is visible. Never identify real people, actors or films.
Return JSON only: {"lines":[{"line":<number>,"pick":"A","start":<seconds>,"fit":"good"}]}`;

/**
 * Looks at real frames of each line's chosen scene and its alternatives (same video when mixing, so the
 * spread stays even), lets the AI pick the best one and the second where the moment starts, and rates the fit.
 * Keeps what was checked if the AI stops part-way.
 */
async function checkClips(projectId: string, cut: StoryCut, input: StoryCutLine[], progress: (m: string) => void, onBatch?: (lines: StoryCutLine[]) => Promise<void>, onlyUnchecked = false): Promise<{ lines: StoryCutLine[]; notes: string }> {
  const lines = input.map(l => ({ ...l, options: [...l.options] }));
  const segById = new Map(cut.segments.map(s => [s.id, s]));
  const todo = lines.filter(l => l.sceneId && segById.has(l.sceneId) && l.text.trim() && (!onlyUnchecked || !l.fit));
  if (!todo.length) bad("No line has a clip to check yet. Find clips for your script first.");
  const mix = mixing(cut);
  const taken = new Set(lines.map(l => l.sceneId).filter((x): x is ID => !!x));
  const files = new Map<ID, string>();
  const fileFor = async (assetId: ID) => {
    if (!files.has(assetId)) {
      const f = await findFile(projectId, assetId);
      if (!f) bad("A footage file is missing from the project.");
      files.set(assetId, f!.filePath);
    }
    return files.get(assetId)!;
  };
  const dir = path.join(projectCacheDir(projectId), "check", randomUUID());
  await fs.mkdir(dir, { recursive: true });
  const fits = { good: 0, loose: 0, poor: 0 };
  let checked = 0, switched = 0, stopped = "";
  try {
    for (let b = 0; b * CHECK_BATCH < todo.length; b++) {
      const batch = todo.slice(b * CHECK_BATCH, (b + 1) * CHECK_BATCH);
      progress(`Looking closely at the clips for lines ${b * CHECK_BATCH + 1}–${b * CHECK_BATCH + batch.length} of ${todo.length}…`);
      const images: { mimeType: string; data: string }[] = [];
      const text: string[] = [];
      const candidates: StoryCutSegment[][] = [];
      for (const [k, l] of batch.entries()) {
        const chosen = segById.get(l.sceneId!)!;
        const others = l.options.map(o => segById.get(o))
          .filter((s): s is StoryCutSegment => !!s && !taken.has(s.id) && (!mix || s.assetId === chosen.assetId));
        const list = [chosen, ...others].slice(0, CHECK_CANDIDATES);
        candidates.push(list);
        text.push(`LINE ${k + 1} (the narrator needs ${Math.max(2, speakSeconds(l.text, cut.voice.speed)).toFixed(1)} s): "${l.text.trim()}"`);
        for (const [c, s] of list.entries()) {
          const len = segmentLength(s);
          const count = Math.min(CHECK_MAX_FRAMES, Math.max(2, Math.round(len / CHECK_STEP)));
          const frames = await extractFramesEvery(await fileFor(s.assetId), s.start, len, count, dir, `${b}-${k}-${c}`);
          const first = images.length + 1;
          for (const fr of frames) images.push({ mimeType: "image/jpeg", data: (await fs.readFile(fr.path)).toString("base64") });
          text.push(`  ${String.fromCharCode(65 + c)} (clip ${len.toFixed(1)} s long): ${frames.map((fr, i) => `image ${first + i} at ${fr.time.toFixed(1)} s`).join(", ") || "no frames"}`);
        }
      }
      const r = await chat({
        system: CHECK_SYSTEM, json: true, maxTokens: 1024, onRetry: progress,
        messages: [{ role: "user", content: `The images below are in order.\n\n${text.join("\n")}\n\nAnswer for lines 1–${batch.length}.`, images }],
      });
      const data = parseJsonObject(r.text);
      for (const a of Array.isArray(data.lines) ? data.lines as { line?: unknown; pick?: unknown; start?: unknown; fit?: unknown }[] : []) {
        const k = sceneNumber(a.line) - 1;
        const l = batch[k];
        if (!l) continue;
        const letter = typeof a.pick === "string" ? a.pick.trim().toUpperCase().charCodeAt(0) - 65 : 0;
        let s = candidates[k][letter] ?? candidates[k][0];
        if (s.id !== l.sceneId && taken.has(s.id)) s = candidates[k][0]; // another line in this batch took it first
        const start = Number(a.start);
        if (s.id !== l.sceneId) {
          taken.delete(l.sceneId!);
          taken.add(s.id);
          l.options = [...new Set([s.id, l.sceneId!, ...l.options])].slice(0, 5);
          l.sceneId = s.id;
          switched++;
        }
        l.offset = linePiece(isFinite(start) ? start : 0, segmentLength(s), l.text, cut.voice.speed).from;
        l.fit = a.fit === "good" || a.fit === "loose" || a.fit === "poor" ? a.fit : "";
        if (l.fit) fits[l.fit]++;
        checked++;
      }
      await onBatch?.(lines);
    }
  } catch (e) {
    if (!checked) throw e;
    stopped = ` Stopped after ${checked} of ${todo.length} lines (${e instanceof Error ? e.message : String(e)}); run “Check clips” again to finish.`;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return {
    lines,
    notes: `Looked at the frames of ${checked} clips: ${fits.good} fit well, ${fits.loose} loosely, ${fits.poor} poorly${fits.poor ? " (marked “poor fit”: choose another scene for those)" : ""}.`
      + `${switched ? ` Switched ${switched} to a better suggestion.` : ""} Each clip now starts at its best moment.${stopped}`,
  };
}

/** `resume`: only the lines not checked yet (after an interrupted run). */
async function runCheck(projectId: string, cut: StoryCut, job: StoryJob, resume: boolean, progress: (m: string) => void) {
  if (resume && cut.lines.every(l => l.fit || !l.sceneId || !l.text.trim())) {
    await patch(projectId, job.id, { status: "succeeded", notes: "Every clip was already checked.", finishedAt: nowIso() });
    return;
  }
  const r = await checkClips(projectId, cut, cut.lines, progress, l => patch(projectId, job.id, { lines: l }), resume);
  await patch(projectId, job.id, { status: "succeeded", lines: r.lines, notes: r.notes, finishedAt: nowIso() });
}

/* ----------------------------------------------------------- stock mode */

async function loadLine(projectId: string, body: { cutId?: unknown; lineId?: unknown }) {
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  const line = cut.lines.find(l => l.id === body.lineId);
  if (!line) bad("Line not found. Wait for the project to save and try again.", 404);
  return { cut, line: line! };
}

/** Downloads another of a line's found clips. The client links it to the line. */
export async function stockSwap(projectId: string, body: { cutId?: unknown; lineId?: unknown; optionId?: unknown }) {
  const { line } = await loadLine(projectId, body);
  const option = line.stock.find(o => o.id === body.optionId);
  if (!option) bad("That clip is no longer in this line's results.", 404);
  return fetchStock(projectId, option!);
}

/** New search for one line (your own words). Returns options with thumbnails; nothing is downloaded yet. */
export async function stockSearchLine(projectId: string, body: { cutId?: unknown; lineId?: unknown; query?: unknown; kind?: unknown }) {
  const { cut, line } = await loadLine(projectId, body);
  const query = typeof body.query === "string" ? body.query.trim().slice(0, 100) : "";
  if (!query) bad("Type what you want to see.");
  const options = await searchStock(projectId, query, body.kind === "photo" ? "photo" : "video", secondsFor(line.text, cut.voice.speed), new Set());
  if (!options.length) bad(`Nothing found for “${query}”. Try simpler words.`, 404);
  return { options, query };
}

/* ------------------------------------------------- one-button script flow */

/**
 * What a "Find clips" run must scan. Everything on the first run or when asked; otherwise only videos
 * without scenes, ignoring a file added twice (it never gets scenes of its own, so it must not force a rescan).
 */
async function scanPlan(projectId: string, cut: StoryCut, rescan: boolean): Promise<{ all: boolean; missing: StoryCut["sources"]; dropped: StoryCutSegment[] }> {
  if (rescan || !cut.segments.length) return { all: true, missing: [], dropped: [] };
  const sourceIds = new Set(cut.sources.map(s => s.assetId));
  const dropped = cut.segments.filter(s => !sourceIds.has(s.assetId));
  const keyOf = async (src: StoryCut["sources"][number]) => {
    const f = await findFile(projectId, src.assetId);
    if (!f) bad("A footage file is missing from the project.");
    return `${(await fs.stat(f!.filePath)).size}:${src.start ?? ""}:${src.end ?? ""}`;
  };
  const seen = new Set<string>();
  for (const src of cut.sources) if (cut.segments.some(s => s.assetId === src.assetId)) seen.add(await keyOf(src));
  const missing: StoryCut["sources"] = [];
  for (const src of cut.sources) {
    if (cut.segments.some(s => s.assetId === src.assetId)) continue;
    const key = await keyOf(src);
    if (!seen.has(key)) { seen.add(key); missing.push(src); }
  }
  return { all: false, missing, dropped };
}

/** Script mode in one go. Each step's result is saved on the job as it finishes, so a later failure keeps earlier work. */
async function runAuto(projectId: string, cut: StoryCut, job: StoryJob, sensitivity: number, rescan: boolean, progress: (m: string) => void) {
  const work: StoryCut = { ...cut, segments: cut.segments.map(s => ({ ...s })), cast: cut.cast.map(m => ({ ...m })) };
  const plan = await scanPlan(projectId, cut, rescan);
  if (plan.all) {
    work.segments = await detectSegments(projectId, cut, sensitivity, m => progress(`Step 1 of 5 · ${m}`));
    await patch(projectId, job.id, { segments: work.segments });
  } else if (plan.missing.length || plan.dropped.length) {
    // Keep the scenes (and descriptions) already found; scan only videos added since, and drop removed ones.
    const added = plan.missing.length
      ? await detectSegments(projectId, { ...cut, sources: plan.missing, segments: [] }, sensitivity, m => progress(`Step 1 of 5 · New video: ${m}`), cut.sources.length)
      : [];
    for (const s of plan.dropped) for (const fr of s.frames) { const p = framePath(projectId, fr); if (p) await fs.rm(p, { force: true }); }
    const dropped = new Set(plan.dropped.map(s => s.id));
    work.segments = [...work.segments.filter(s => !dropped.has(s.id)), ...added];
    await patch(projectId, job.id, { segments: work.segments });
  }

  const d = await describeSegments(projectId, work.segments, false, m => progress(`Step 2 of 5 · Watching the film: ${m.replace(/^Looking at /, "")}`),
    desc => patch(projectId, job.id, { descriptions: desc }));
  for (const s of work.segments) if (d.descriptions[s.id]) s.description = d.descriptions[s.id];
  if (!work.segments.some(s => s.description.trim())) bad("The AI couldn't describe any scene, so it can't match your script. Try again.", 502);

  let castNote = "";
  if (!work.cast.some(m => m.name.trim()) && !mixing(work)) { // when mixing videos, a fixed cast would pull every pick back to one film
    progress("Step 3 of 5 · Casting your characters…");
    const c = await castFor(work, m => progress(`Step 3 of 5 · ${m}`));
    work.cast = c.cast;
    await patch(projectId, job.id, { cast: c.cast });
    castNote = ` Cast: ${c.cast.map(m => `${m.name} = ${m.look || "not in the footage"}`).join("; ")}.`;
  }

  progress("Step 4 of 5 · Picking a clip for each line of your script…");
  const m = await matchFor(work, msg => progress(`Step 4 of 5 · ${msg}`));
  const matched = `${work.segments.length} scenes watched. ${m.notes}${castNote}`;
  await patch(projectId, job.id, { lines: m.lines, notes: matched });

  // Step 5: look at the real frames of each pick and pin the moment. If it fails, the matched lines still stand.
  let lines = m.lines, checkNote = "";
  try {
    const c = await checkClips(projectId, work, m.lines, msg => progress(`Step 5 of 5 · ${msg}`), l => patch(projectId, job.id, { lines: l }));
    lines = c.lines;
    checkNote = ` ${c.notes}`;
  } catch (e) {
    checkNote = ` The close look at each clip didn't finish (${e instanceof Error ? e.message : String(e)}); press “Check clips” to try again.`;
  }
  await patch(projectId, job.id, { status: "succeeded", lines, finishedAt: nowIso(), notes: `${matched}${checkNote}` });
}

/* ---------------------------------------------------------------- render */

const VOICE_PAD = 0.5; // seconds after the voice ends (includes the 150 ms start delay)

interface Clip { key: ID; assetId: ID; start: number; sceneLength: number; narration: string; fitToVoice: boolean }

/** What gets rendered, in order. Story mode: the scenes; script mode: each line over its chosen scene. */
function clipsFor(cut: StoryCut): Clip[] {
  if (cut.mode !== "story") {
    const byId = new Map(cut.segments.map(s => [s.id, s]));
    return cut.lines.flatMap(l => {
      const s = l.sceneId ? byId.get(l.sceneId) : undefined;
      if (!s) return [];
      const from = linePiece(l.offset, segmentLength(s), l.text, cut.voice.speed).from; // start at the line's moment in the scene
      return [{ key: l.id, assetId: s.assetId, start: s.start + from, sceneLength: segmentLength(s) - from, narration: l.text.trim(), fitToVoice: true }];
    });
  }
  return cut.segments.filter(s => !s.skip).map(s => ({ key: s.id, assetId: s.assetId, start: s.start, sceneLength: segmentLength(s), narration: s.narration.trim(), fitToVoice: false }));
}

const MIN_CLIP = 2; // seconds; very short lines still show their picture for a moment

async function runRender(projectId: string, cut: StoryCut, job: StoryJob, progress: (m: string) => void) {
  const segs = clipsFor(cut);
  const voiced = segs.filter(s => s.narration);
  const voiceDir = path.join(projectCacheDir(projectId), "voice");
  await fs.mkdir(voiceDir, { recursive: true });
  const voiceFor = new Map<ID, { file: string; seconds: number }>();
  const provider = audioProvider(cut.voice.providerId);

  for (const [i, s] of voiced.entries()) {
    const key = createHash("sha1").update(`${cut.voice.providerId}|${cut.voice.voice}|${cut.voice.speed}|${s.narration}`).digest("hex");
    const file = path.join(voiceDir, `${key}.wav`);
    if (!existsSync(file)) {
      if (!provider) bad("Voice engine not found.");
      const r = await provider!.generate(
        { text: s.narration, settings: { voice: cut.voice.voice, speed: cut.voice.speed } },
        m => progress(`Voice ${i + 1} of ${voiced.length}: ${m}`),
      );
      await fs.writeFile(file, r.data);
    } else {
      progress(`Voice ${i + 1} of ${voiced.length}: reusing the earlier recording`);
    }
    const pcm = parseWav(await fs.readFile(file));
    voiceFor.set(s.key, { file, seconds: pcm.data.length / (pcm.sampleRate * pcm.channels * 2) });
  }

  progress("Preparing the edit…");
  const probes = new Map<ID, { file: string; still: boolean; info: Probe }>();
  const parts: RenderPart[] = [];
  let extended = 0;
  for (const s of segs) {
    if (!probes.has(s.assetId)) {
      const f = await findFile(projectId, s.assetId);
      if (!f) bad("A footage file is missing from the project.");
      const still = f!.mimeType.startsWith("image/");
      probes.set(s.assetId, { file: f!.filePath, still, info: still ? { duration: 0, hasAudio: false, width: 0, height: 0 } : await probe(f!.filePath) });
    }
    const src = probes.get(s.assetId)!;
    const v = voiceFor.get(s.key);
    const scene = s.sceneLength;
    // Script mode follows the voice (the scene is trimmed or runs on); story mode keeps whole scenes.
    const duration = s.fitToVoice
      ? (v ? Math.max(MIN_CLIP, v.seconds + VOICE_PAD) : scene)
      : Math.max(scene, v ? v.seconds + VOICE_PAD : 0);
    if (duration > scene + 0.05) extended++;
    parts.push({ file: src.file, start: s.start, duration, hasAudio: src.info.hasAudio, voiceFile: v?.file ?? null, still: src.still });
  }

  const workDir = path.join(projectCacheDir(projectId), `render-${job.id}`);
  const out = path.join(workDir, "out.mp4");
  try {
    await renderParts(parts, cut.filmVolume, workDir, out, (frac, m) => progress(`${m} ${Math.round(frac * 100)}%`));
    const total = parts.reduce((n, p) => n + p.duration, 0);
    const output = await saveGeneratedFileFromPath(projectId, out, "video/mp4", cut.title.trim() || "Story cut");
    output.notes = `Story cut “${cut.title}”: ${parts.length} scenes, ${Math.round(total)} s. Voice: ${cut.voice.voice} (${cut.voice.providerId}).`;
    await patch(projectId, job.id, {
      status: "succeeded", output, finishedAt: nowIso(),
      notes: `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")} long, ${parts.length} scenes.${extended ? ` ${extended} scene${extended > 1 ? "s were" : " was"} lengthened to fit the narration (the footage continues past the cut).` : ""}`,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
