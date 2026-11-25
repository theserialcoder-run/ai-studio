// Image generation providers. Server-only. Each adapter declares honest
// capabilities: whether reference images actually condition the model.
import type { ImageCaps, ImageProviderInfo, ImageSettings, ReferenceInput } from "../../ai/types";
import { comfyImageProviders } from "./comfyui";
import { env, errorDetail, explainHttpError, postJsonLong, ProviderError, sniffImageMime } from "./http";

export interface ImageJob {
  prompt: string;
  negativePrompt: string;
  settings: ImageSettings;
  references: ReferenceInput[];
  source: ReferenceInput | null;
}
export interface ImageOutput { data: Buffer; mimeType: string }
export interface ImageResult { images: ImageOutput[]; notes: string }

export interface ImageProvider {
  info(): ImageProviderInfo;
  estimate(settings: ImageSettings): string;
  generate(job: ImageJob, onProgress?: (message: string) => void): Promise<ImageResult>;
}

const RATIOS_COMMON = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

/** Width/height for a ratio with the long side = `long`, multiples of 16, clamped. */
function dims(ratio: string, long = 1024, min = 256, max = 1920) {
  const [a, b] = ratio.split(":").map(Number);
  const r = a > 0 && b > 0 ? a / b : 1;
  const round = (n: number) => Math.min(max, Math.max(min, Math.round(n / 16) * 16));
  return r >= 1 ? { width: round(long), height: round(long / r) } : { width: round(long * r), height: round(long) };
}

/** Text appended to prompts so the model knows what each reference image is. */
function referenceLegend(refs: ReferenceInput[], indexBase: number) {
  if (!refs.length) return "";
  return "\n\nReference images: " + refs.map((r, i) => `image ${i + indexBase} = ${r.label}`).join("; ") +
    ". Keep each character's face, hairstyle, body and clothing, and each location's architecture, layout and key objects, consistent with their reference images.";
}

/* ---------------------------------------------------------- Cloudflare AI */

function cfCreds() {
  const account = env("CLOUDFLARE_ACCOUNT_ID"), token = env("CLOUDFLARE_API_TOKEN");
  if (!account || !token) throw new ProviderError("Cloudflare Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env.local.", 400);
  return { account, token };
}

async function cfRun(model: string, body: BodyInit, json: boolean): Promise<Buffer> {
  const { account, token } = cfCreds();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) },
    body,
  }).catch(e => { throw new ProviderError(`Could not reach Cloudflare: ${e.message}`, 502); });
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok) throw explainHttpError("Cloudflare Workers AI", res.status, errorDetail(await res.text()));
  if (ctype.startsWith("image/")) return Buffer.from(await res.arrayBuffer());
  const data = await res.json();
  const b64 = data?.result?.image ?? data?.image;
  if (typeof b64 !== "string" || !b64) {
    throw new ProviderError(`Cloudflare returned no image. ${data?.errors?.[0]?.message ?? ""}`.trim(), 502);
  }
  return Buffer.from(b64.replace(/^data:[^,]+,/, ""), "base64");
}

const CF_NOTE = "Workers AI Free plan: 10,000 neurons/day at no charge, no payment method needed; requests fail with 429 once the daily allocation is used (resets 00:00 UTC).";
const CF_SETUP = "Cloudflare dashboard → AI → Workers AI → Use REST API: copy the Account ID and create an API token with Workers AI permission. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.";

function cfFlux2(id: string, model: string, label: string, estimate: string, steps: ImageCaps["steps"]): ImageProvider {
  const caps: ImageCaps = {
    maxReferences: 4, imageToImage: true, aspectRatios: RATIOS_COMMON, sizes: [], steps,
    seed: true, guidance: true, negativePrompt: false, referenceMaxSide: 511,
  };
  return {
    info: () => ({
      kind: "image", id, label, vendor: "Cloudflare Workers AI", model,
      configured: !!(env("CLOUDFLARE_ACCOUNT_ID") && env("CLOUDFLARE_API_TOKEN")), billing: "free-allocation",
      costNote: `${estimate} ${CF_NOTE}`, requirements: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], setup: CF_SETUP,
      conditioning: "Reference-conditioned: up to 4 reference images (each downscaled below 512×512) are sent to FLUX.2 as input images. This improves identity/location consistency but does not guarantee it.",
      caps,
    }),
    estimate: () => estimate,
    async generate(job) {
      const refs = [...(job.source ? [job.source] : []), ...job.references].slice(0, 4);
      const { width, height } = dims(job.settings.aspectRatio || "1:1");
      const count = Math.min(4, Math.max(1, job.settings.count ?? 1));
      const images: ImageOutput[] = [];
      for (let n = 0; n < count; n++) {
        const form = new FormData();
        const sourceNote = job.source ? `\n\nEdit/transform image 0 (${job.source.label}) according to the prompt.` : "";
        form.append("prompt", job.prompt + sourceNote + referenceLegend(job.source ? refs.slice(1) : refs, job.source ? 1 : 0));
        form.append("width", String(width));
        form.append("height", String(height));
        if (steps && job.settings.steps) form.append("steps", String(Math.min(steps.max, Math.max(steps.min, job.settings.steps))));
        if (job.settings.guidance) form.append("guidance", String(job.settings.guidance));
        if (job.settings.seed !== undefined) form.append("seed", String(job.settings.seed + n));
        refs.forEach((r, i) => form.append(`input_image_${i}`, new Blob([Buffer.from(r.data, "base64")], { type: r.mimeType }), `ref${i}.jpg`));
        const buf = await cfRun(model, form, false);
        images.push({ data: buf, mimeType: sniffImageMime(buf) });
      }
      return { images, notes: "" };
    },
  };
}

const cfSchnell: ImageProvider = {
  info: () => ({
    kind: "image", id: "cloudflare-flux-1-schnell", label: "FLUX.1 [schnell] (Cloudflare)", vendor: "Cloudflare Workers AI",
    model: "@cf/black-forest-labs/flux-1-schnell",
    configured: !!(env("CLOUDFLARE_ACCOUNT_ID") && env("CLOUDFLARE_API_TOKEN")), billing: "free-allocation",
    costNote: `Very cheap (a few dozen neurons per image). ${CF_NOTE}`, requirements: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], setup: CF_SETUP,
    conditioning: "Text-only: reference images are NOT used. Consistency relies on descriptions alone, which is not reliable.",
    caps: { maxReferences: 0, imageToImage: false, aspectRatios: ["1:1"], sizes: [], steps: { min: 1, max: 8, default: 4 }, seed: true, guidance: false, negativePrompt: false, referenceMaxSide: 0 },
  }),
  estimate: () => "≈ 50–80 neurons per image (well within the free daily allocation).",
  async generate(job) {
    const count = Math.min(4, Math.max(1, job.settings.count ?? 1));
    const images: ImageOutput[] = [];
    for (let n = 0; n < count; n++) {
      const body: Record<string, unknown> = { prompt: job.prompt.slice(0, 2048), steps: Math.min(8, Math.max(1, job.settings.steps ?? 4)) };
      if (job.settings.seed !== undefined) body.seed = job.settings.seed + n;
      const buf = await cfRun("@cf/black-forest-labs/flux-1-schnell", JSON.stringify(body), true);
      images.push({ data: buf, mimeType: sniffImageMime(buf) });
    }
    return { images, notes: job.references.length ? "This model is text-only; the selected reference images were not used." : "" };
  },
};

/* ------------------------------------------------- Gemini (Nano Banana) */
// Interactions API: POST /v1beta/interactions with input parts and response_format.

const GEMINI_IMAGE_PRICES: Record<string, Record<string, number>> = {
  "gemini-nano-banana-2.1": { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 },
  "gemini-3.1-flash-image": { "1K": 0.067, "2K": 0.101, "4K": 0.151 },
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
};

/** Collect content blocks of a given type from model_output steps only (never echo our inputs). */
export function modelOutputBlocks(data: unknown, type: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const steps = (data as { steps?: unknown[]; outputs?: unknown[] })?.steps ?? (data as { outputs?: unknown[] })?.outputs ?? [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const st = step as { type?: string; content?: unknown[] };
    if (st.type && st.type !== "model_output") continue;
    for (const block of Array.isArray(st.content) ? st.content : [st]) {
      const b = block as Record<string, unknown>;
      if (b?.type === type) out.push(b);
    }
  }
  return out;
}

const geminiImage: ImageProvider = {
  info: () => {
    const model = env("GEMINI_IMAGE_MODEL") || "gemini-nano-banana-2.1";
    const p = GEMINI_IMAGE_PRICES[model];
    return {
      kind: "image", id: "gemini-image", label: "Gemini image (Nano Banana)", vendor: "Google AI Studio", model,
      configured: !!env("GEMINI_API_KEY"), billing: "paid",
      costNote: p ? `Paid only (no free tier for image models): about $${p["1K"]} per 1K image, $${p["2K"]} 2K, $${p["4K"]} 4K. Requires billing enabled on the API key's project.` : "Paid only; see Gemini API pricing. Requires billing enabled.",
      requirements: ["GEMINI_API_KEY", "billing enabled in Google AI Studio"],
      setup: "Use the same GEMINI_API_KEY; enable billing for its project in AI Studio. Optional GEMINI_IMAGE_MODEL (gemini-nano-banana-2.1, gemini-3.1-flash-image, gemini-3-pro-image).",
      conditioning: "Reference-conditioned: up to 14 labelled reference images (Nano Banana 2.x: up to 4 character + 10 object images) are sent with the prompt; also supports editing a source image. Improves but does not guarantee consistency.",
      caps: {
        maxReferences: 14, imageToImage: true,
        aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"],
        sizes: ["1K", "2K", "4K"], steps: null, seed: false, guidance: false, negativePrompt: false, referenceMaxSide: 1536,
      },
    };
  },
  estimate: s => {
    const i = geminiImage.info();
    const price = GEMINI_IMAGE_PRICES[i.model]?.[s.size || "1K"];
    const n = Math.min(4, Math.max(1, s.count ?? 1));
    return price ? `≈ $${(price * n).toFixed(3)} for ${n} image${n > 1 ? "s" : ""} at ${s.size || "1K"} (${i.model}).` : `Paid per image (${i.model}); see Gemini pricing.`;
  },
  async generate(job) {
    const key = env("GEMINI_API_KEY");
    if (!key) throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to .env.local.", 400);
    const { model } = geminiImage.info();
    const input: Record<string, unknown>[] = [];
    if (job.source) {
      input.push({ type: "text", text: `Image to edit — ${job.source.label}:` });
      input.push({ type: "image", mime_type: job.source.mimeType, data: job.source.data });
    }
    job.references.forEach((r, i) => {
      input.push({ type: "text", text: `Reference ${i + 1} — ${r.label}:` });
      input.push({ type: "image", mime_type: r.mimeType, data: r.data });
    });
    const consistency = job.references.length
      ? "\n\nUse the reference images to keep each character's identity (face, hairstyle, body, clothing for the named wardrobe) and each location's architecture, layout and important objects consistent."
      : "";
    input.push({ type: "text", text: (job.source ? "Edit the image above as follows: " : "") + job.prompt + consistency });

    const count = Math.min(4, Math.max(1, job.settings.count ?? 1));
    const images: ImageOutput[] = [];
    const notes: string[] = [];
    for (let n = 0; n < count; n++) {
      const { status, text } = await postJsonLong("https://generativelanguage.googleapis.com/v1beta/interactions",
        { "x-goog-api-key": key, "Api-Revision": "2026-05-20" },
        { model, input, store: false, response_format: { type: "image", aspect_ratio: job.settings.aspectRatio || "1:1", image_size: job.settings.size || "1K" } },
        5 * 60_000);
      if (status < 200 || status >= 300) throw explainHttpError("Gemini", status, errorDetail(text));
      const data = JSON.parse(text);
      for (const b of modelOutputBlocks(data, "image")) {
        if (typeof b.data === "string") {
          const buf = Buffer.from(b.data, "base64");
          images.push({ data: buf, mimeType: typeof b.mime_type === "string" ? b.mime_type : sniffImageMime(buf) });
        }
      }
      for (const b of modelOutputBlocks(data, "text")) if (typeof b.text === "string" && b.text.trim()) notes.push(b.text.trim());
    }
    if (!images.length) throw new ProviderError(`Gemini returned no image.${notes.length ? ` Model said: ${notes.join(" ").slice(0, 400)}` : ""}`, 502);
    return { images, notes: notes.join("\n").slice(0, 2000) };
  },
};

const PROVIDERS: ImageProvider[] = [
  ...comfyImageProviders,
  cfFlux2("cloudflare-flux-2-klein", "@cf/black-forest-labs/flux-2-klein-9b", "FLUX.2 [klein] 9B (Cloudflare)",
    "≈ 1,364 neurons per 1-megapixel image + ≈ 182 per reference (≈ 7 images/day on the free allocation).", null),
  cfFlux2("cloudflare-flux-2-dev", "@cf/black-forest-labs/flux-2-dev", "FLUX.2 [dev] (Cloudflare)",
    "≈ 37.5 neurons per 512² output tile per step (1024×768, 20 steps ≈ 3,000+ neurons ≈ 2–3 images/day free).", { min: 4, max: 50, default: 20 }),
  cfSchnell,
  geminiImage,
];

export function imageProviders(): ImageProvider[] {
  return PROVIDERS;
}

export function imageProvider(id: string): ImageProvider | undefined {
  return PROVIDERS.find(p => p.info().id === id);
}

