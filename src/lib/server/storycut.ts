// Story Cuts: scene detection, AI scene description, story writing and rendering.
// Server-only. Jobs run in the background one at a time (this laptop has 8 GB RAM);
// results are stored in storycuts.json and imported into the project by the client.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { nowIso } from "../projectModel";
import { segmentLength, styleById, wordBudget, type StoryDraft, type StoryJob, type StoryJobKind, type StoryJobView } from "../storyCut";
import type { ID, StoryCut, StoryCutSegment } from "../types";
import { audioProvider, parseWav } from "./ai/audio";
import { ProviderError } from "./ai/http";
import { activeLlm, chat } from "./ai/llm";
import { detectScenes, extractFrame, mediaTools, probe, renderParts, type Probe, type RenderPart } from "./media";
import { findFile, projectCacheDir, readProject, readSideFile, saveGeneratedFileFromPath, StorageError, updateSideFile } from "./storage";

const MAX_RECORDS = 40;
const MAX_SCENES = 400;
const DESCRIBE_BATCH = 10;

const active = new Map<ID, string>(); // job id → progress message
let chain: Promise<unknown> = Promise.resolve();

const bad = (msg: string, status = 400): never => { throw new ProviderError(msg, status); };
const framesDir = (projectId: string) => path.join(projectCacheDir(projectId), "frames");
export const FRAME_NAME = /^[A-Za-z0-9_-]{1,80}\.jpg$/;

export function framePath(projectId: string, name: string): string | null {
  return FRAME_NAME.test(name) ? path.join(framesDir(projectId), name) : null;
}

async function patch(projectId: string, id: ID, changes: Partial<StoryJob>) {
  await updateSideFile<StoryJob[]>(projectId, "storycuts", [], list => list.map(j => (j.id === id ? { ...j, ...changes } : j)));
}

export async function listStoryJobs(projectId: string): Promise<StoryJobView[]> {
  const list = await readSideFile<StoryJob[]>(projectId, "storycuts", []);
  const stale = list.filter(j => j.status === "running" && !active.has(j.id));
  if (stale.length) {
    const msg = "Interrupted because the Wonderboy server restarted. Start it again.";
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
export async function startStoryJob(projectId: string, body: { kind?: unknown; cutId?: unknown; overwrite?: unknown; sensitivity?: unknown }): Promise<StoryJob> {
  const kind = body.kind as StoryJobKind;
  if (!["detect", "describe", "render"].includes(kind)) bad("kind must be detect, describe or render.");
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  if (kind !== "describe") { const t = await mediaTools(); if (!t.ok) bad(t.error!); }
  if (kind === "detect" && !cut.sources.length) bad("Add at least one video first.");
  if (kind === "describe") {
    if (!cut.segments.some(s => s.frames.length)) bad("Detect scenes first.");
    if (!activeLlm()) bad("Describing scenes needs an AI text model that can see images. Set GEMINI_API_KEY in .env.local (free tier) and restart.");
  }
  if (kind === "render") {
    const clips = clipsFor(cut);
    if (!clips.length) bad(cut.mode === "script" ? "No line has a scene yet. Match scenes to your script first." : "There are no scenes to render.");
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

  const job: StoryJob = {
    id: randomUUID(), kind, cutId: cut.id, cutTitle: cut.title, status: "running", error: null, notes: "", createdAt: nowIso(), finishedAt: null,
  };
  await updateSideFile<StoryJob[]>(projectId, "storycuts", [], cur => [job, ...cur].slice(0, MAX_RECORDS));
  active.set(job.id, "Waiting for the previous job to finish…");
  const sensitivity = typeof body.sensitivity === "number" ? Math.min(0.6, Math.max(0.1, body.sensitivity)) : 0.3;
  const overwrite = body.overwrite === true;

  chain = chain.then(async () => {
    const progress = (m: string) => active.set(job.id, m);
    try {
      const fresh = await loadCut(projectId, cut.id).catch(() => cut);
      if (kind === "detect") await runDetect(projectId, fresh, job, sensitivity, progress);
      if (kind === "describe") await runDescribe(projectId, fresh, job, overwrite, progress);
      if (kind === "render") await runRender(projectId, fresh, job, progress);
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
  // Higher "sensitivity" in the UI = more cuts = lower ffmpeg scene threshold.
  const threshold = Math.round((0.7 - sensitivity) * 100) / 100;
  const found: (StoryCutSegment & { file: string })[] = [];
  for (const [i, src] of cut.sources.entries()) {
    const f = await findFile(projectId, src.assetId);
    if (!f) bad("A footage file is missing from the project.");
    const pr = await probe(f!.filePath);
    const start = Math.min(Math.max(0, src.start ?? 0), Math.max(0, pr.duration - 1));
    const end = src.end && src.end > start + 1 ? Math.min(src.end, pr.duration) : pr.duration;
    const label = cut.sources.length > 1 ? ` (video ${i + 1} of ${cut.sources.length})` : "";
    const scenes = await detectScenes(f!.filePath, start, end, threshold, frac => progress(`Finding scenes${label}… ${Math.round(frac * 100)}%`));
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
  const total = segments.reduce((n, s) => n + segmentLength(s), 0);
  await patch(projectId, job.id, { status: "succeeded", segments, notes: `${segments.length} scenes, ${Math.round(total)} s of footage.`, finishedAt: nowIso() });
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
  const targets = cut.segments.filter(s => s.frames.length && (overwrite || !s.description.trim()));
  if (!targets.length) {
    await patch(projectId, job.id, { status: "succeeded", descriptions: {}, notes: "Every scene already has a description.", finishedAt: nowIso() });
    return;
  }
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
        system: DESCRIBE_SYSTEM, json: true, maxTokens: 4096,
        messages: [{ role: "user", content: `The images below are in order.\n${lines.join("\n")}\n\nDescribe scenes 1–${batch.length}.`, images }],
      });
      provider = r.provider;
      const data = parseJsonObject(r.text);
      const scenes = Array.isArray(data.scenes) ? data.scenes as { scene?: unknown; description?: unknown }[] : [];
      for (const sc of scenes) {
        const idx = Number(sc.scene) - 1;
        if (batch[idx] && typeof sc.description === "string" && sc.description.trim()) descriptions[batch[idx].id] = sc.description.trim().slice(0, 800);
      }
      await patch(projectId, job.id, { descriptions });
    }
  } catch (e) {
    if (Object.keys(descriptions).length) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`${msg} (${Object.keys(descriptions).length} of ${targets.length} scenes were described and kept; run it again to finish.)`, 502);
    }
    throw e;
  }
  const missed = targets.length - Object.keys(descriptions).length;
  await patch(projectId, job.id, {
    status: "succeeded", descriptions, finishedAt: nowIso(),
    notes: `Described ${Object.keys(descriptions).length} scenes with ${provider}.${missed ? ` ${missed} came back empty; describe them yourself or run again.` : ""}`,
  });
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

function sceneCatalogue(cut: StoryCut): string {
  return cut.segments.map((s, i) => `Scene ${i + 1} (${segmentLength(s).toFixed(1)} s): ${s.description.trim() || "(no description)"}`).join("\n");
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
  const r = await chat({
    system: CAST_SYSTEM, json: true, maxTokens: 2048,
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

export async function matchScript(projectId: string, body: { cutId?: unknown }): Promise<{ lines: { id: ID; text: string; sceneId: ID | null; options: ID[] }[]; notes: string; provider: string }> {
  const cut = await loadCut(projectId, String(body.cutId ?? ""));
  requireScriptInputs(cut);
  const lengths = cut.segments.map(segmentLength).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 5;
  const maxWords = Math.min(30, Math.max(10, wordBudget(median * 1.6, cut.voice.speed)));
  const cast = cut.cast.filter(m => m.name.trim());
  const prompt = [
    cast.length ? `CAST (character = person in the footage):\n${cast.map(m => `${m.name} = ${m.look || "(not in the footage)"}`).join("\n")}` : "CAST: not given; infer who is who from the descriptions.",
    `SCRIPT:\n${cut.script.trim().slice(0, 20000)}`,
    `FOOTAGE SCENES:\n${sceneCatalogue(cut)}`,
  ].join("\n\n");
  const r = await chat({ system: MATCH_SYSTEM.replace("MAX_WORDS", String(maxWords)), json: true, maxTokens: 16384, messages: [{ role: "user", content: prompt }] });
  const data = parseJsonObject(r.text);
  const raw = Array.isArray(data.lines) ? data.lines as { text?: unknown; scenes?: unknown }[] : [];
  const used = new Set<ID>();
  let unmatched = 0;
  const lines = raw.filter(l => typeof l.text === "string" && l.text.trim()).slice(0, 500).map(l => {
    const options = [...new Set((Array.isArray(l.scenes) ? l.scenes : []).map(n => cut.segments[Number(n) - 1]?.id).filter((x): x is ID => !!x))].slice(0, 3);
    // First unused suggestion becomes the pick, so a scene isn't shown twice.
    const sceneId = options.find(o => !used.has(o)) ?? null;
    if (sceneId) used.add(sceneId); else unmatched++;
    return { id: randomUUID(), text: String(l.text).replace(/\s+/g, " ").trim().slice(0, 1000), sceneId, options };
  });
  if (!lines.length) bad("The AI returned no lines. Try again.", 502);
  return {
    lines, provider: r.provider,
    notes: `${lines.length} lines, ${lines.length - unmatched} with a scene.${unmatched ? ` ${unmatched} need a scene: pick one yourself.` : ""}`,
  };
}

/* ---------------------------------------------------------------- render */

const VOICE_PAD = 0.5; // seconds after the voice ends (includes the 150 ms start delay)

interface Clip { key: ID; assetId: ID; start: number; sceneLength: number; narration: string; fitToVoice: boolean }

/** What gets rendered, in order. Story mode: the scenes; script mode: each line over its chosen scene. */
function clipsFor(cut: StoryCut): Clip[] {
  if (cut.mode === "script") {
    const byId = new Map(cut.segments.map(s => [s.id, s]));
    return cut.lines.flatMap(l => {
      const s = l.sceneId ? byId.get(l.sceneId) : undefined;
      return s ? [{ key: l.id, assetId: s.assetId, start: s.start, sceneLength: segmentLength(s), narration: l.text.trim(), fitToVoice: true }] : [];
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
  const probes = new Map<ID, { file: string; info: Probe }>();
  const parts: RenderPart[] = [];
  let extended = 0;
  for (const s of segs) {
    if (!probes.has(s.assetId)) {
      const f = await findFile(projectId, s.assetId);
      if (!f) bad("A footage file is missing from the project.");
      probes.set(s.assetId, { file: f!.filePath, info: await probe(f!.filePath) });
    }
    const src = probes.get(s.assetId)!;
    const v = voiceFor.get(s.key);
    const scene = s.sceneLength;
    // Script mode follows the voice (the scene is trimmed or runs on); story mode keeps whole scenes.
    const duration = s.fitToVoice
      ? (v ? Math.max(MIN_CLIP, v.seconds + VOICE_PAD) : scene)
      : Math.max(scene, v ? v.seconds + VOICE_PAD : 0);
    if (duration > scene + 0.05) extended++;
    parts.push({ file: src.file, start: s.start, duration, hasAudio: src.info.hasAudio, voiceFile: v?.file ?? null });
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
