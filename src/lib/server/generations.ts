// Generation jobs: validation, background execution and persisted records
// (data/projects/<id>/generations.json). Server-only.
import { randomUUID } from "node:crypto";
import type { GenerationRecord, GenerationRequest, ReferenceInput } from "../ai/types";
import { nowIso } from "../projectModel";
import { audioProvider } from "./ai/audio";
import { imageProvider } from "./ai/image";
import { ProviderError } from "./ai/http";
import { videoProvider } from "./ai/video";
import { readSideFile, saveGeneratedFile, StorageError, updateSideFile } from "./storage";

const MAX_RECORDS = 300;
const MAX_ACTIVE = 3;
const MAX_REF_BYTES = 8 * 1024 * 1024;

/** In-flight jobs of this server process: generation id → latest progress message. */
const active = new Map<string, string>();

type Store = GenerationRecord[];

function bad(message: string): never {
  throw new StorageError(message, 400);
}

function cleanRef(r: unknown): ReferenceInput {
  const x = (r ?? {}) as Record<string, unknown>;
  const data = typeof x.data === "string" ? x.data.replace(/^data:[^,]+,/, "") : "";
  const mimeType = typeof x.mimeType === "string" ? x.mimeType : "";
  if (!data || !/^image\/(png|jpeg|webp)$/.test(mimeType)) bad("Each reference must be a PNG, JPEG or WebP image.");
  if (data.length * 0.75 > MAX_REF_BYTES) bad("A reference image is too large (max 8 MB).");
  return {
    assetId: typeof x.assetId === "string" ? x.assetId : "", role: (typeof x.role === "string" ? x.role : "other") as ReferenceInput["role"],
    label: typeof x.label === "string" ? x.label.slice(0, 200) : "reference", mimeType, data,
  };
}

export async function listGenerations(projectId: string): Promise<(GenerationRecord & { progress: string | null })[]> {
  const records = await readSideFile<Store>(projectId, "generations", []);
  const stale = records.filter(r => r.status === "running" && !active.has(r.id));
  if (stale.length) {
    // Jobs that were running when the server stopped can't be resumed.
    await updateSideFile<Store>(projectId, "generations", [], cur => cur.map(r => (r.status === "running" && !active.has(r.id)
      ? { ...r, status: "failed", error: "Interrupted: the Wonderboy server stopped while this job was running. Check the provider dashboard before retrying, in case it was charged.", finishedAt: nowIso() }
      : r)));
    return listGenerations(projectId);
  }
  return records.map(r => ({ ...r, progress: active.get(r.id) ?? null }));
}

async function patchRecord(projectId: string, id: string, patch: Partial<GenerationRecord>) {
  await updateSideFile<Store>(projectId, "generations", [], cur => cur.map(r => (r.id === id ? { ...r, ...patch } : r)));
}

/** Validates the request, stores a "running" record and starts the job without awaiting it. */
export async function startGeneration(projectId: string, raw: unknown, outputLabel: string): Promise<GenerationRecord> {
  const req = (raw ?? {}) as Partial<GenerationRequest>;
  const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
  if (!prompt) bad("Write a prompt first.");
  if (prompt.length > 20_000) bad("Text is too long (max 20,000 characters).");
  if (active.size >= MAX_ACTIVE) bad(`${MAX_ACTIVE} generations are already running. Wait for one to finish.`);
  const negativePrompt = typeof req.negativePrompt === "string" ? req.negativePrompt.slice(0, 2000) : "";
  const references = (Array.isArray(req.references) ? req.references : []).map(cleanRef);
  const source = req.sourceImage ? cleanRef(req.sourceImage) : null;
  const shotId = typeof req.shotId === "string" ? req.shotId : null;

  let run: (onProgress: (m: string) => void) => Promise<{ files: { data: Buffer; mimeType: string }[]; notes: string }>;
  let base: Pick<GenerationRecord, "type" | "providerId" | "providerLabel" | "model" | "imageSettings" | "videoSettings" | "costEstimate"> & Partial<Pick<GenerationRecord, "audioSettings">>;

  if (req.type === "image") {
    const p = imageProvider(String(req.providerId));
    if (!p) bad("Unknown image provider.");
    const info = p.info();
    if (!info.configured) bad(`${info.label} is not configured: set ${info.requirements.join(", ")} in .env.local and restart.`);
    const s = req.imageSettings ?? { aspectRatio: "1:1" };
    if (!info.caps.aspectRatios.includes(s.aspectRatio)) bad(`${info.label} does not support aspect ratio ${s.aspectRatio}.`);
    if (s.size && info.caps.sizes.length && !info.caps.sizes.includes(s.size)) bad(`${info.label} does not support size ${s.size}.`);
    if (source && !info.caps.imageToImage) bad(`${info.label} does not support image-to-image.`);
    const refLimit = info.caps.maxReferences - (source ? 1 : 0);
    if (references.length > Math.max(0, refLimit)) bad(`${info.label} accepts at most ${Math.max(0, refLimit)} reference images${source ? " plus the source image" : ""}.`);
    if (info.billing === "paid" && req.approvedPaid !== true) bad(`${info.label} is a paid service. Approve the estimated cost to continue.`);
    const settings = { aspectRatio: s.aspectRatio, size: s.size, steps: s.steps, seed: s.seed, guidance: s.guidance, count: Math.min(4, Math.max(1, s.count ?? 1)) };
    base = { type: "image", providerId: info.id, providerLabel: info.label, model: info.model, imageSettings: settings, videoSettings: null, costEstimate: p.estimate(settings) };
    run = async () => {
      const r = await p.generate({ prompt, negativePrompt, settings, references, source });
      return { files: r.images, notes: r.notes };
    };
  } else if (req.type === "video") {
    const p = videoProvider(String(req.providerId));
    if (!p) bad("Unknown video provider.");
    const info = p.info();
    if (!info.configured) bad(`${info.label} is not configured: set ${info.requirements.join(", ")} in .env.local and restart.`);
    const s = req.videoSettings ?? { durationSec: 5 };
    if (source && !info.caps.imageToVideo) bad(`${info.label} does not support image-to-video.`);
    if (!source && !info.caps.textToVideo) bad(`${info.label} does not support text-to-video.`);
    if (!info.caps.durations.includes(s.durationSec)) bad(`${info.label} supports durations: ${info.caps.durations.join(", ")} seconds.`);
    if (s.resolution && !info.caps.resolutions.includes(s.resolution)) bad(`${info.label} does not support ${s.resolution}.`);
    if (s.aspectRatio && info.caps.aspectRatios.length && !info.caps.aspectRatios.includes(s.aspectRatio)) bad(`${info.label} does not support aspect ratio ${s.aspectRatio}.`);
    if (references.length > info.caps.maxReferences) bad(`${info.label} accepts at most ${info.caps.maxReferences} reference images.`);
    if (info.billing === "paid" && req.approvedPaid !== true) bad(`${info.label} is a paid service. Approve the estimated cost to continue.`);
    const settings = { aspectRatio: s.aspectRatio, durationSec: s.durationSec, resolution: s.resolution, generateAudio: !!s.generateAudio };
    base = { type: "video", providerId: info.id, providerLabel: info.label, model: info.model, imageSettings: null, videoSettings: settings, costEstimate: p.estimate(settings, source ? "image" : "text") };
    run = async onProgress => {
      const r = await p.generate({ prompt, negativePrompt, settings, startImage: source, references }, onProgress);
      return { files: [{ data: r.data, mimeType: r.mimeType }], notes: r.notes };
    };
  } else if (req.type === "audio") {
    const p = audioProvider(String(req.providerId));
    if (!p) bad("Unknown voice provider.");
    const info = p.info();
    if (!info.configured) bad(`${info.label} is not configured: set ${info.requirements.join(", ")} in .env.local and restart.`);
    if (prompt.length > info.caps.maxChars) bad(`${info.label} accepts at most ${info.caps.maxChars} characters per generation.`);
    const s = req.audioSettings ?? { voice: "" };
    if (!info.caps.voices.some(v => v.id === s.voice)) bad("Choose a voice.");
    const settings = { voice: s.voice, speed: info.caps.speed ? s.speed ?? info.caps.speed.default : undefined, style: info.caps.style ? String(s.style ?? "").slice(0, 500) : undefined };
    base = { type: "audio", providerId: info.id, providerLabel: info.label, model: info.model, imageSettings: null, videoSettings: null, audioSettings: settings, costEstimate: p.estimate({ text: prompt, settings }) };
    run = async onProgress => {
      const r = await p.generate({ text: prompt, settings }, onProgress);
      return { files: [{ data: r.data, mimeType: r.mimeType }], notes: r.notes };
    };
  } else {
    bad("type must be image, video or audio.");
  }

  const record: GenerationRecord = {
    id: randomUUID(), ...base, status: "running", error: null, prompt, negativePrompt,
    references: references.map(r => ({ assetId: r.assetId, role: r.role, label: r.label })),
    sourceAssetId: source?.assetId || null, shotId, outputs: [], notes: "", createdAt: nowIso(), finishedAt: null,
  };
  await updateSideFile<Store>(projectId, "generations", [], cur => [record, ...cur].slice(0, MAX_RECORDS));
  active.set(record.id, "Starting…");

  void (async () => {
    try {
      const result = await run(msg => active.set(record.id, msg));
      const outputs = [];
      for (let i = 0; i < result.files.length; i++) {
        const f = result.files[i];
        outputs.push(await saveGeneratedFile(projectId, f.data, f.mimeType, `${outputLabel}${result.files.length > 1 ? ` (${i + 1})` : ""}`));
      }
      for (const o of outputs) o.notes = `Generated by ${record.providerLabel} (${record.model}). Prompt: ${prompt.slice(0, 500)}`;
      await patchRecord(projectId, record.id, { status: "succeeded", outputs, notes: result.notes, finishedAt: nowIso() });
    } catch (e) {
      const message = e instanceof ProviderError || e instanceof StorageError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      if (!(e instanceof ProviderError)) console.error(e);
      await patchRecord(projectId, record.id, { status: "failed", error: message, finishedAt: nowIso() }).catch(() => {});
    } finally {
      active.delete(record.id);
    }
  })();

  return record;
}
