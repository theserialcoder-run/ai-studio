// ComfyUI on a GPU you run yourself (e.g. a RunPod pod). Server-only.
//
// Wonderboy talks to ComfyUI's HTTP API:
//   POST /upload/image  → reference/source images
//   POST /prompt        → queue an API-format workflow graph
//   GET  /queue, /history/{id} → progress and results
//   GET  /view          → download the output image
//   GET  /object_info/{Class} → node inputs and installed model files (used to
//        fill defaults for inputs that newer ComfyUI versions add, and to check models)
//
// Generating costs nothing per image: you pay your GPU host by the hour while the
// pod runs. Wonderboy never starts or stops the pod (that is step 2 of the roadmap).
import { randomUUID } from "node:crypto";
import type { ComfyStatus, ComfyWorkflowStatus, ImageCaps, ImageProviderInfo, ReferenceInput } from "../../ai/types";
import { getSettings } from "../settings";
import { env, errorDetail, ProviderError, sniffImageMime } from "./http";
import type { ImageJob, ImageProvider, ImageResult } from "./image";

/* ------------------------------------------------------------ connection */

export function comfyConfig(): { url: string; authHeader: string; source: "settings" | "env" | null } {
  const s = getSettings().comfyui;
  if (s.url) return { url: s.url.replace(/\/+$/, ""), authHeader: s.authHeader || env("COMFYUI_AUTH"), source: "settings" };
  const e = env("COMFYUI_URL");
  if (e) return { url: e.replace(/\/+$/, ""), authHeader: env("COMFYUI_AUTH"), source: "env" };
  return { url: "", authHeader: "", source: null };
}

export function validComfyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function comfyFetch(pathAndQuery: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  const { url, authHeader } = comfyConfig();
  if (!url) throw new ProviderError("ComfyUI is not connected. Paste your pod's ComfyUI address in Settings → ComfyUI GPU.", 400);
  const headers = new Headers(init.headers);
  if (authHeader) headers.set("Authorization", authHeader);
  let res: Response;
  try {
    res = await fetch(`${url}${pathAndQuery}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? "it did not answer in time" : e instanceof Error ? e.message : String(e);
    throw new ProviderError(`Could not reach your ComfyUI at ${url} (${why}). Is the GPU pod running, and is the address right?`, 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(`Your ComfyUI refused the request (${res.status}). Check the authorization header in Settings → ComfyUI GPU.`, 401);
  }
  // RunPod's proxy answers 502/503/504 while the pod is stopped or ComfyUI is still starting.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ProviderError(`Your ComfyUI at ${url} is not answering (${res.status}). The pod may be stopped or ComfyUI is still starting; wait a minute and retry.`, 502);
  }
  return res;
}

async function comfyJson<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
  const res = await comfyFetch(pathAndQuery, init);
  const text = await res.text();
  if (!res.ok) throw new ProviderError(`ComfyUI request ${pathAndQuery.split("?")[0]} failed (${res.status}). ${errorDetail(text).slice(0, 400)}`, 502);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`ComfyUI returned something that isn't JSON for ${pathAndQuery.split("?")[0]}. Is the address pointing at ComfyUI (usually port 8188)?`, 502);
  }
}

/* ------------------------------------------------------------- node info */

type InputSpec = [unknown, Record<string, unknown>?];
interface NodeInfo { input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> } }

async function nodeInfo(classes: string[]): Promise<Record<string, NodeInfo>> {
  const out: Record<string, NodeInfo> = {};
  await Promise.all([...new Set(classes)].map(async c => {
    const data = await comfyJson<Record<string, NodeInfo>>(`/object_info/${encodeURIComponent(c)}`);
    if (!data[c]) throw new ProviderError(`Your ComfyUI has no "${c}" node. Update ComfyUI to a current version (the RunPod template's ComfyUI Manager → Update ComfyUI) and restart it.`, 400);
    out[c] = data[c];
  }));
  return out;
}

/** Options of a combo input, for both the old ([list]) and new ("COMBO", {options}) formats. */
function comboOptions(spec: InputSpec | undefined): string[] | null {
  if (!spec) return null;
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return (spec[1]!.options as unknown[]).map(String);
  return null;
}

function defaultFor(spec: InputSpec): unknown {
  const opts = comboOptions(spec);
  if (spec[1] && "default" in spec[1]) return spec[1].default;
  if (opts) return opts[0];
  if (spec[0] === "BOOLEAN") return false;
  if (spec[0] === "INT" || spec[0] === "FLOAT") return 0;
  if (spec[0] === "STRING") return "";
  return undefined; // a link input (MODEL, IMAGE, …): can't invent one
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Fill required widget inputs this workflow doesn't set (inputs added by newer ComfyUI versions). */
function fillDefaults(graph: Graph, info: Record<string, NodeInfo>) {
  for (const node of Object.values(graph)) {
    const req = info[node.class_type]?.input?.required ?? {};
    for (const [name, spec] of Object.entries(req)) {
      if (name in node.inputs) continue;
      const d = defaultFor(spec);
      if (d !== undefined) node.inputs[name] = d;
    }
  }
}

/* ----------------------------------------------------------------- models */

interface ModelFile { node: string; input: string; folder: string; name: string; url: string; optional?: string }

function zImageFiles(): ModelFile[] {
  return [
    { node: "UNETLoader", input: "unet_name", folder: "diffusion_models", name: env("COMFYUI_ZIMAGE_MODEL") || "z_image_turbo_bf16.safetensors",
      url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors" },
    { node: "CLIPLoader", input: "clip_name", folder: "text_encoders", name: "qwen_3_4b.safetensors",
      url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" },
    { node: "VAELoader", input: "vae_name", folder: "vae", name: "ae.safetensors",
      url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" },
  ];
}

const QWEN_LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors";
function qwenEditFiles(): ModelFile[] {
  return [
    { node: "UNETLoader", input: "unet_name", folder: "diffusion_models", name: env("COMFYUI_QWEN_EDIT_MODEL") || "qwen_image_edit_2511_fp8mixed.safetensors",
      url: "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors" },
    { node: "CLIPLoader", input: "clip_name", folder: "text_encoders", name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      url: "https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" },
    { node: "VAELoader", input: "vae_name", folder: "vae", name: "qwen_image_vae.safetensors",
      url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors" },
    { node: "LoraLoaderModelOnly", input: "lora_name", folder: "loras", name: QWEN_LORA, optional: "needed for fast 4–8 step mode",
      url: `https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/${QWEN_LORA}` },
  ];
}

function missingFiles(files: ModelFile[], info: Record<string, NodeInfo>): ModelFile[] {
  return files.filter(f => {
    const opts = comboOptions(info[f.node]?.input?.required?.[f.input]);
    // ComfyUI lists files with forward slashes; a file in a subfolder shows as "sub/name".
    return !opts || !opts.some(o => o === f.name || o.endsWith(`/${f.name}`));
  });
}

function resolveName(f: ModelFile, info: Record<string, NodeInfo>): string {
  const opts = comboOptions(info[f.node]?.input?.required?.[f.input]) ?? [];
  return opts.find(o => o === f.name) ?? opts.find(o => o.endsWith(`/${f.name}`)) ?? f.name;
}

function missingError(label: string, files: ModelFile[]): ProviderError {
  const list = files.map(f => `${f.folder}/${f.name}`).join(", ");
  return new ProviderError(`${label}: your ComfyUI is missing ${list}. Download them into ComfyUI/models (Settings → ComfyUI GPU → Test connection shows the commands), then retry.`, 400);
}

/* ------------------------------------------------------------- running */

async function uploadImage(ref: ReferenceInput): Promise<string> {
  const form = new FormData();
  const ext = ref.mimeType === "image/png" ? "png" : ref.mimeType === "image/webp" ? "webp" : "jpg";
  form.append("image", new Blob([Buffer.from(ref.data, "base64")], { type: ref.mimeType }), `wonderboy-${randomUUID()}.${ext}`);
  form.append("type", "input");
  form.append("overwrite", "true");
  const r = await comfyJson<{ name: string; subfolder?: string }>("/upload/image", { method: "POST", body: form });
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

function nodeErrorsText(data: unknown): string {
  const d = data as { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> };
  const parts: string[] = [];
  if (d?.error?.message) parts.push(`${d.error.message}${d.error.details ? ` (${d.error.details})` : ""}`);
  for (const ne of Object.values(d?.node_errors ?? {})) {
    for (const e of ne.errors ?? []) parts.push(`${ne.class_type ?? "node"}: ${e.message ?? ""}${e.details ? ` — ${e.details}` : ""}`);
  }
  return parts.join("; ").slice(0, 600);
}

const MAX_WAIT_MS = 20 * 60_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Queue a graph, wait for it, return the images saved by its SaveImage node. */
async function runGraph(graph: Graph, onProgress: (m: string) => void, label: string): Promise<Buffer[]> {
  const res = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: "wonderboy" }),
  });
  const text = await res.text();
  let data: { prompt_id?: string } & Record<string, unknown> = {};
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !data.prompt_id) {
    throw new ProviderError(`ComfyUI rejected the ${label} workflow (${res.status}). ${nodeErrorsText(data) || errorDetail(text).slice(0, 400)}`, 400);
  }
  const id = data.prompt_id;
  const started = Date.now();
  let lostSince = 0;

  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(2000);
    const hist = await comfyJson<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(id)}`);
    const entry = hist[id];
    if (entry) {
      const msgs = entry.status?.messages ?? [];
      const err = msgs.find(m => m[0] === "execution_error")?.[1];
      if (entry.status?.status_str === "error" || err) {
        const detail = err ? `${String(err.node_type ?? "")}: ${String(err.exception_message ?? "").trim()}` : "unknown error";
        const oom = /out of memory|OOM|CUDA error/i.test(detail) ? " The GPU ran out of memory: try a smaller size or a GPU with more VRAM." : "";
        throw new ProviderError(`ComfyUI failed while generating: ${detail.slice(0, 500)}${oom}`, 502);
      }
      if (msgs.some(m => m[0] === "execution_interrupted")) throw new ProviderError("The job was cancelled in ComfyUI.", 502);
      const files = Object.values(entry.outputs ?? {}).flatMap(o => o.images ?? []).filter(i => i.type === "output");
      if (entry.status?.completed || files.length) {
        if (!files.length) throw new ProviderError("ComfyUI finished but saved no image.", 502);
        onProgress("Downloading the image…");
        const out: Buffer[] = [];
        for (const f of files) {
          const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
          const r = await comfyFetch(`/view?${q}`, {}, 120_000);
          if (!r.ok) throw new ProviderError(`Could not download the result from ComfyUI (${r.status}).`, 502);
          out.push(Buffer.from(await r.arrayBuffer()));
        }
        return out;
      }
    }
    const queue = await comfyJson<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue");
    const secs = Math.round((Date.now() - started) / 1000);
    if ((queue.queue_running ?? []).some(q => q[1] === id)) {
      lostSince = 0;
      onProgress(`Generating on your GPU… ${secs}s${secs > 60 ? " (the first run loads the model, which takes longer)" : ""}`);
    } else {
      const pending = (queue.queue_pending ?? []).map(q => ({ n: Number(q[0]), id: q[1] })).sort((a, b) => a.n - b.n);
      const pos = pending.findIndex(p => p.id === id);
      if (pos >= 0) {
        lostSince = 0;
        onProgress(`Queued on your GPU (${pos + (queue.queue_running?.length ?? 0)} ahead)… ${secs}s`);
      } else if (!entry) {
        // Neither queued, running nor in history: ComfyUI was probably restarted.
        lostSince ||= Date.now();
        if (Date.now() - lostSince > 30_000) throw new ProviderError("ComfyUI lost the job (it may have restarted). Retry.", 502);
      }
    }
  }
  throw new ProviderError(`ComfyUI did not finish within ${MAX_WAIT_MS / 60_000} minutes. The job may still be running in ComfyUI.`, 504);
}

/** Size with about `megapixels` MP for a ratio, multiples of 16. */
function sizeFor(ratio: string, megapixels: number) {
  const [a, b] = ratio.split(":").map(Number);
  const r = a > 0 && b > 0 ? a / b : 1;
  const w = Math.sqrt(megapixels * 1_000_000 * r);
  const round = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { width: round(w), height: round(w / r) };
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 32);
const RATIOS = ["16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
const SIZE_MP: Record<string, number> = { "1K": 1.05, "2K": 2.07 }; // 16:9 → 1360×768 and 1920×1088

const SETUP = "Rent a GPU pod (e.g. RunPod, RTX 4090 or 5090, ComfyUI template), download the models (Settings → ComfyUI GPU → Test connection lists them), then paste the pod's ComfyUI address (https://<pod-id>-8188.proxy.runpod.net) in Settings → ComfyUI GPU. Or set COMFYUI_URL.";
const COST = "No per-image cost: you pay your GPU host by the hour while the pod runs (RTX 4090 on RunPod ≈ $0.34–0.69/hr, Nov 2026). Stop the pod when you're done.";

function baseInfo(id: string, label: string, model: string, conditioning: string, caps: ImageCaps): ImageProviderInfo {
  return {
    kind: "image", id, label, vendor: "Your ComfyUI GPU", model,
    configured: !!comfyConfig().url, billing: "self-hosted", costNote: COST,
    requirements: ["ComfyUI address (Settings → ComfyUI GPU) or COMFYUI_URL"], setup: SETUP, conditioning, caps,
  };
}

/* ----------------------------------------------------- Z-Image Turbo (T2I) */

const zImage: ImageProvider = {
  info: () => baseInfo("comfyui-z-image", "Z-Image Turbo (your GPU)", "Z-Image-Turbo 6B (Apache-2.0)",
    "Text-only: reference images are NOT used. Fast and photorealistic; consistency relies on descriptions, which is not reliable. Use Qwen-Image-Edit for reference-conditioned shots.",
    { maxReferences: 0, imageToImage: false, aspectRatios: RATIOS, sizes: ["1K", "2K"], steps: { min: 4, max: 20, default: 8 }, seed: true, guidance: false, negativePrompt: false, referenceMaxSide: 0 }),
  estimate: () => "Free per image (GPU time only; a few seconds per image on an RTX 4090).",
  async generate(job: ImageJob, onProgress = () => {}): Promise<ImageResult> {
    const files = zImageFiles();
    const classes = ["UNETLoader", "CLIPLoader", "VAELoader", "ModelSamplingAuraFlow", "CLIPTextEncode", "ConditioningZeroOut", "EmptySD3LatentImage", "KSampler", "VAEDecode", "SaveImage"];
    onProgress("Checking your ComfyUI…");
    const info = await nodeInfo(classes);
    const missing = missingFiles(files, info);
    if (missing.length) throw missingError("Z-Image Turbo", missing);
    const [unet, clip, vae] = files.map(f => resolveName(f, info));
    const { width, height } = sizeFor(job.settings.aspectRatio, SIZE_MP[job.settings.size ?? "1K"] ?? 1.05);
    const count = Math.min(4, Math.max(1, job.settings.count ?? 1));
    const seed = job.settings.seed ?? randomSeed();

    const graph: Graph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "lumina2", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: vae } },
      "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
      "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: job.prompt } },
      "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
      "7": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: count } },
      "8": { class_type: "KSampler", inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed, steps: Math.min(20, Math.max(4, job.settings.steps ?? 8)), cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1,
      } },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "wonderboy/z-image" } },
    };
    fillDefaults(graph, info);
    const bufs = await runGraph(graph, onProgress, "Z-Image");
    return { images: bufs.map(data => ({ data, mimeType: sniffImageMime(data) })), notes: `Seed ${seed}, ${width}×${height}.` };
  },
};

/* ------------------------------------- Qwen-Image-Edit 2511 (references) */

const qwenEdit: ImageProvider = {
  info: () => baseInfo("comfyui-qwen-edit", "Qwen-Image-Edit 2511 (your GPU)", "Qwen-Image-Edit-2511 20B (Apache-2.0)",
    "Reference-conditioned: up to 3 images (the source image, then the shot's character/location references) are given to Qwen-Image-Edit as Picture 1–3. Keeps faces, clothing and places closer to the references, but does not guarantee it. 4–8 steps uses the Lightning LoRA (fast); more steps runs the full model (slower, CFG applies).",
    { maxReferences: 3, imageToImage: true, aspectRatios: RATIOS, sizes: ["1K"], steps: { min: 4, max: 40, default: 4 }, seed: true, guidance: true, negativePrompt: true, referenceMaxSide: 1024 }),
  estimate: () => "Free per image (GPU time only; roughly 10–30 s per image on an RTX 4090 in fast mode, longer at 20–40 steps).",
  async generate(job: ImageJob, onProgress = () => {}): Promise<ImageResult> {
    const steps = Math.min(40, Math.max(4, job.settings.steps ?? 4));
    const fast = steps <= 8;
    const files = qwenEditFiles().filter(f => fast || f.node !== "LoraLoaderModelOnly");
    const images = [...(job.source ? [job.source] : []), ...job.references].slice(0, 3);
    const classes = ["UNETLoader", "CLIPLoader", "VAELoader", "ModelSamplingAuraFlow", "CFGNorm", "TextEncodeQwenImageEditPlus",
      "FluxKontextMultiReferenceLatentMethod", "KSampler", "VAEDecode", "SaveImage",
      ...(fast ? ["LoraLoaderModelOnly"] : []), ...(images.length ? ["LoadImage"] : []),
      ...(job.source ? ["FluxKontextImageScale", "VAEEncode"] : ["EmptySD3LatentImage"])];
    onProgress("Checking your ComfyUI…");
    const info = await nodeInfo(classes);
    const missing = missingFiles(files, info);
    if (missing.length) throw missingError("Qwen-Image-Edit", missing);
    const [unet, clip, vae, lora] = files.map(f => resolveName(f, info));

    onProgress(images.length ? `Uploading ${images.length} image${images.length > 1 ? "s" : ""} to your GPU…` : "Preparing…");
    const uploaded: string[] = [];
    for (const img of images) uploaded.push(await uploadImage(img));

    const legend = images.length
      ? `\n\n${images.map((r, i) => `Picture ${i + 1} is ${r.role === "source" ? "the image to edit" : r.label}`).join(". ")}. Keep each character's face, hairstyle, body and clothing, and each location's architecture and key objects, consistent with their pictures.`
      : "";
    const cfg = fast ? 1 : Math.min(10, Math.max(1, job.settings.guidance ?? 4));
    const seed = job.settings.seed ?? randomSeed();
    const count = Math.min(4, Math.max(1, job.settings.count ?? 1));
    const { width, height } = sizeFor(job.settings.aspectRatio, SIZE_MP["1K"]);

    const graph: Graph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "qwen_image", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: vae } },
      "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
      "5": { class_type: "CFGNorm", inputs: { model: ["4", 0], strength: 1 } },
    };
    let model: [string, number] = ["5", 0];
    if (fast) {
      graph["6"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["5", 0], lora_name: lora, strength_model: 1 } };
      model = ["6", 0];
    }
    const imageLinks: Record<string, [string, number]> = {};
    uploaded.forEach((name, i) => {
      graph[`20${i}`] = { class_type: "LoadImage", inputs: { image: name } };
      imageLinks[`image${i + 1}`] = [`20${i}`, 0];
    });
    let latent: [string, number];
    if (job.source) {
      // Editing: picture 1 is scaled to a model-friendly size and also sets the output size.
      graph["30"] = { class_type: "FluxKontextImageScale", inputs: { image: imageLinks.image1 } };
      imageLinks.image1 = ["30", 0];
      graph["31"] = { class_type: "VAEEncode", inputs: { pixels: ["30", 0], vae: ["3", 0] } };
      latent = ["31", 0];
    } else {
      graph["31"] = { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: count } };
      latent = ["31", 0];
    }
    const encode = (text: string) => ({ class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], vae: ["3", 0], prompt: text, ...imageLinks } });
    graph["40"] = encode(job.prompt + legend);
    graph["41"] = encode(job.negativePrompt);
    graph["42"] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["40", 0], reference_latents_method: "index_timestep_zero" } };
    graph["43"] = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["41", 0], reference_latents_method: "index_timestep_zero" } };
    graph["50"] = { class_type: "KSampler", inputs: {
      model, positive: ["42", 0], negative: ["43", 0], latent_image: latent,
      seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1,
    } };
    graph["51"] = { class_type: "VAEDecode", inputs: { samples: ["50", 0], vae: ["3", 0] } };
    graph["52"] = { class_type: "SaveImage", inputs: { images: ["51", 0], filename_prefix: "wonderboy/qwen-edit" } };
    fillDefaults(graph, info);

    const out: Buffer[] = [];
    // An encoded source latent is a single image, so extra takes are separate runs with new seeds.
    const runs = job.source ? count : 1;
    for (let n = 0; n < runs; n++) {
      if (n > 0) (graph["50"].inputs as { seed: number }).seed = seed + n;
      out.push(...await runGraph(graph, m => onProgress(runs > 1 ? `Take ${n + 1}/${runs}: ${m}` : m), "Qwen-Image-Edit"));
    }
    const notes = [`Seed ${seed}${runs > 1 ? `…${seed + runs - 1}` : ""}, ${fast ? `fast mode (Lightning LoRA, ${steps} steps)` : `${steps} steps, CFG ${cfg}`}.`];
    if (job.references.length + (job.source ? 1 : 0) > 3) notes.push("Only the first 3 images were used.");
    return { images: out.map(data => ({ data, mimeType: sniffImageMime(data) })), notes: notes.join(" ") };
  },
};

export const comfyImageProviders: ImageProvider[] = [zImage, qwenEdit];

/* ----------------------------------------------------------- status check */

export async function comfyStatus(check: boolean): Promise<ComfyStatus> {
  const cfg = comfyConfig();
  const status: ComfyStatus = { url: cfg.url, hasAuth: !!cfg.authHeader, source: cfg.source };
  if (!check || !cfg.url) return status;
  try {
    const stats = await comfyJson<{ system?: { comfyui_version?: string }; devices?: { name?: string; vram_total?: number; vram_free?: number }[] }>("/system_stats");
    const dev = stats.devices?.[0];
    const info = await nodeInfo(["UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly"]);
    const wf = (id: string, label: string, files: ModelFile[]): ComfyWorkflowStatus => {
      const missing = new Set(missingFiles(files, info));
      return {
        id, label, ready: files.every(f => f.optional || !missing.has(f)),
        files: files.map(f => ({ folder: f.folder, name: f.name, present: !missing.has(f), url: f.url, optional: f.optional })),
      };
    };
    status.check = {
      ok: true,
      comfyVersion: stats.system?.comfyui_version,
      gpu: dev?.name,
      vramTotalGb: dev?.vram_total ? Math.round(dev.vram_total / 1e9 * 10) / 10 : undefined,
      vramFreeGb: dev?.vram_free ? Math.round(dev.vram_free / 1e9 * 10) / 10 : undefined,
      workflows: [wf("comfyui-z-image", "Z-Image Turbo (text-to-image)", zImageFiles()), wf("comfyui-qwen-edit", "Qwen-Image-Edit 2511 (references)", qwenEditFiles())],
    };
  } catch (e) {
    status.check = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return status;
}
