// Video generation providers. Server-only. All current video APIs are paid.
import type { ReferenceInput, VideoProviderInfo, VideoSettings } from "../../ai/types";
import { download, env, errorDetail, explainHttpError, fetchOrThrow, postJsonLong, ProviderError, sleep } from "./http";
import { modelOutputBlocks } from "./image";

export interface VideoJob {
  prompt: string;
  negativePrompt: string;
  settings: VideoSettings;
  startImage: ReferenceInput | null;
  references: ReferenceInput[];
}
export interface VideoResult { data: Buffer; mimeType: string; notes: string }

export interface VideoProvider {
  info(): VideoProviderInfo;
  estimate(s: VideoSettings, mode: "text" | "image"): string;
  generate(job: VideoJob, onProgress: (msg: string) => void): Promise<VideoResult>;
}

/* ---------------------------------------------------- Gemini Omni Flash */

const OMNI_PRICE: Record<string, number> = { "360p": 0.023, "720p": 0.07, "1080p": 0.104, "4k": 0.209 };

const geminiOmni: VideoProvider = {
  info: () => ({
    kind: "video", id: "gemini-omni", label: "Gemini Omni Flash video", vendor: "Google AI Studio",
    model: env("GEMINI_VIDEO_MODEL") || "gemini-omni-1.2-flash",
    configured: !!env("GEMINI_API_KEY"), billing: "paid",
    costNote: "Paid only (no free tier): about $0.023/s at 360p, $0.07/s at 720p, $0.104/s at 1080p, $0.209/s at 4K. Requires billing on the API key's project.",
    requirements: ["GEMINI_API_KEY", "billing enabled in Google AI Studio"],
    setup: "Same GEMINI_API_KEY as chat, with billing enabled. Optional GEMINI_VIDEO_MODEL.",
    conditioning: "Supports text-to-video, image-to-video (start frame) and reference-to-video with up to 6 reference images (max 3 per character, 2 characters). References improve but do not guarantee consistency.",
    caps: {
      textToVideo: true, imageToVideo: true, maxReferences: 6, durations: [3, 4, 5, 6, 8, 10, 12, 15],
      aspectRatios: ["16:9", "9:16"], resolutions: ["360p", "720p", "1080p", "4k"], negativePrompt: true,
      costPerSecond: OMNI_PRICE, imageMaxSide: 1920,
    },
  }),
  estimate: s => {
    const rate = OMNI_PRICE[s.resolution || "720p"] ?? OMNI_PRICE["720p"];
    return `≈ $${(rate * s.durationSec).toFixed(2)} for ${s.durationSec}s at ${s.resolution || "720p"}.`;
  },
  async generate(job, onProgress) {
    const key = env("GEMINI_API_KEY");
    if (!key) throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to .env.local.", 400);
    const input: Record<string, unknown>[] = [];
    if (job.startImage) {
      input.push({ type: "image", mime_type: job.startImage.mimeType, data: job.startImage.data });
    } else {
      job.references.slice(0, 6).forEach((r, i) => {
        input.push({ type: "text", text: `Reference ${i + 1} — ${r.label}:` });
        input.push({ type: "image", mime_type: r.mimeType, data: r.data });
      });
    }
    const avoid = job.negativePrompt.trim() ? `\nAvoid: ${job.negativePrompt.trim()}` : "";
    const lead = job.startImage ? "Animate the image above. " : job.references.length ? "Use the reference images to keep characters and the location consistent. " : "";
    input.push({ type: "text", text: lead + job.prompt + avoid });

    onProgress("Generating video with Gemini Omni (this can take several minutes)…");
    const { status, text } = await postJsonLong("https://generativelanguage.googleapis.com/v1beta/interactions",
      { "x-goog-api-key": key },
      {
        model: geminiOmni.info().model, input, store: false,
        response_format: {
          type: "video", aspect_ratio: job.settings.aspectRatio || "16:9", resolution: job.settings.resolution || "720p",
          duration: `${Math.round(Math.min(15, Math.max(3, job.settings.durationSec)))}s`, delivery: "uri",
        },
      }, 20 * 60_000);
    if (status < 200 || status >= 300) throw explainHttpError("Gemini Omni", status, errorDetail(text));
    const data = JSON.parse(text);
    const notes = modelOutputBlocks(data, "text").map(b => String(b.text ?? "")).join("\n").trim();
    const block = modelOutputBlocks(data, "video")[0];
    if (!block) throw new ProviderError(`Gemini Omni returned no video.${notes ? ` Model said: ${notes.slice(0, 400)}` : ""}`, 502);
    if (typeof block.data === "string") return { data: Buffer.from(block.data, "base64"), mimeType: String(block.mime_type ?? "video/mp4"), notes };

    const uri = String(block.uri ?? "");
    const fileId = /files\/([^:/?]+)/.exec(uri)?.[1];
    if (!fileId) throw new ProviderError("Gemini Omni returned an unrecognised video reference.", 502);
    onProgress("Video generated; waiting for the file to be ready…");
    for (let i = 0; i < 60; i++) {
      const res = await fetchOrThrow("Gemini Files", `https://generativelanguage.googleapis.com/v1beta/files/${fileId}`, { headers: { "x-goog-api-key": key } });
      const f = await res.json();
      if (f.state === "ACTIVE") break;
      if (f.state === "FAILED") throw new ProviderError("Gemini reported the video file as FAILED.", 502);
      await sleep(5000);
    }
    const url = uri.startsWith("http") ? uri : `https://generativelanguage.googleapis.com/v1beta/files/${fileId}:download?alt=media`;
    const file = await download("Gemini Files", url, { "x-goog-api-key": key });
    return { data: file.data, mimeType: file.mimeType.startsWith("video/") ? file.mimeType : "video/mp4", notes };
  },
};

/* ----------------------------------------------------------------- fal.ai */

const falI2V = () => env("FAL_I2V_MODEL") || "fal-ai/kling-video/v3/standard/image-to-video";
const falT2V = () => env("FAL_T2V_MODEL") || "fal-ai/wan/v2.2-a14b/text-to-video";

const fal: VideoProvider = {
  info: () => ({
    kind: "video", id: "fal", label: "fal.ai (Kling / Wan)", vendor: "fal.ai",
    model: `${falI2V()} · ${falT2V()}`,
    configured: !!env("FAL_KEY"), billing: "paid",
    costNote: "Pay-as-you-go, prepaid credits: Kling 3.0 Standard image-to-video ≈ $0.14/s (5s ≈ $0.70). Wan 2.2 text-to-video: see fal.ai pricing. Not charged for server errors.",
    requirements: ["FAL_KEY"],
    setup: "Create a key at fal.ai/dashboard/keys and add credits. Set FAL_KEY. Optional FAL_I2V_MODEL / FAL_T2V_MODEL to switch models (request fields must match).",
    conditioning: "Image-to-video animates one start image (e.g. a generated, reference-conditioned frame). Text-to-video (Wan) uses the prompt only — no reference conditioning.",
    caps: {
      textToVideo: true, imageToVideo: true, maxReferences: 0, durations: [3, 5, 8, 10],
      aspectRatios: ["16:9", "9:16", "1:1"], resolutions: ["480p", "720p"], negativePrompt: true,
      costPerSecond: { default: 0.14 }, imageMaxSide: 1920,
    },
  }),
  estimate: (s, mode) => mode === "image" ? `≈ $${(0.14 * s.durationSec).toFixed(2)} for ${s.durationSec}s (Kling 3.0 Standard).` : "Wan 2.2 text-to-video: price per fal.ai pricing page (prepaid credits).",
  async generate(job, onProgress) {
    const key = env("FAL_KEY");
    if (!key) throw new ProviderError("fal.ai is not configured. Add FAL_KEY to .env.local.", 400);
    const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
    const d = Math.round(job.settings.durationSec);
    let model: string, input: Record<string, unknown>;
    if (job.startImage) {
      model = falI2V();
      input = {
        prompt: job.prompt, start_image_url: `data:${job.startImage.mimeType};base64,${job.startImage.data}`,
        duration: String(Math.min(15, Math.max(3, d))), generate_audio: !!job.settings.generateAudio,
        ...(job.negativePrompt.trim() ? { negative_prompt: job.negativePrompt } : {}),
      };
    } else {
      model = falT2V();
      const fps = 16;
      input = {
        prompt: job.prompt, aspect_ratio: job.settings.aspectRatio || "16:9", resolution: job.settings.resolution || "720p",
        frames_per_second: fps, num_frames: Math.min(161, Math.max(17, d * fps + 1)),
        ...(job.negativePrompt.trim() ? { negative_prompt: job.negativePrompt } : {}),
      };
    }
    const submit = await fetchOrThrow("fal.ai", `https://queue.fal.run/${model}`, { method: "POST", headers, body: JSON.stringify(input) });
    const q = await submit.json() as { request_id?: string; status_url?: string; response_url?: string };
    if (!q.status_url || !q.response_url) throw new ProviderError("fal.ai did not return a queue request.", 502);
    onProgress(`Queued on fal.ai (${model})…`);
    const deadline = Date.now() + 30 * 60_000;
    while (true) {
      if (Date.now() > deadline) throw new ProviderError(`fal.ai request ${q.request_id} did not finish within 30 minutes. It may still complete in your fal dashboard.`, 504);
      await sleep(5000);
      const st = await (await fetchOrThrow("fal.ai", q.status_url, { headers })).json() as { status?: string; queue_position?: number; error?: string };
      if (st.status === "IN_QUEUE") onProgress(`Waiting in fal.ai queue${st.queue_position !== undefined ? ` (position ${st.queue_position})` : ""}…`);
      else if (st.status === "IN_PROGRESS") onProgress("Rendering on fal.ai…");
      else if (st.status === "COMPLETED") {
        if (st.error) throw new ProviderError(`fal.ai generation failed: ${st.error}`, 502);
        break;
      }
    }
    const result = await (await fetchOrThrow("fal.ai", q.response_url, { headers })).json() as { video?: { url?: string; content_type?: string } };
    const url = result.video?.url;
    if (!url) throw new ProviderError("fal.ai finished but returned no video URL.", 502);
    const file = await download("fal.ai", url);
    return { data: file.data, mimeType: result.video?.content_type || (file.mimeType.startsWith("video/") ? file.mimeType : "video/mp4"), notes: `Model: ${model}` };
  },
};

const PROVIDERS: VideoProvider[] = [geminiOmni, fal];

export function videoProviders(): VideoProvider[] {
  return PROVIDERS;
}

export function videoProvider(id: string): VideoProvider | undefined {
  return PROVIDERS.find(p => p.info().id === id);
}
