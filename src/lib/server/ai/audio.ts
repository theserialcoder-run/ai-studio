// Text-to-speech providers. Server-only.
// - Kokoro-82M runs locally on the CPU (free, unlimited, Apache-2.0, English only in kokoro-js).
// - Gemini TTS runs in Google's cloud (free tier with unpublished daily limits, 100+ languages incl. Hindi).
import path from "node:path";
import type { AudioProviderInfo, AudioSettings, VoiceOption } from "../../ai/types";
import { processState } from "../processState";
import { dataRoot } from "../storage";
import { env, errorDetail, explainHttpError, postJsonLong, ProviderError } from "./http";

export interface AudioJob { text: string; settings: AudioSettings }
export interface AudioResult { data: Buffer; mimeType: string; notes: string }
export interface AudioProvider {
  info(): AudioProviderInfo;
  estimate(job: AudioJob): string;
  generate(job: AudioJob, onProgress: (msg: string) => void): Promise<AudioResult>;
}

/* ---------------------------------------------------------------- WAV utils */

interface Pcm { sampleRate: number; channels: number; data: Buffer } // 16-bit signed LE

export function parseWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new ProviderError("Provider returned audio that is not a WAV file.", 502);
  let off = 12, sampleRate = 24000, channels = 1, bits = 16;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(off + 10); sampleRate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    if (id === "data") { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new ProviderError("WAV audio has no data chunk.", 502);
  if (bits !== 16) throw new ProviderError(`Unsupported WAV bit depth ${bits}.`, 502);
  return { sampleRate, channels, data };
}

function encodeWav(pcm: Pcm): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(pcm.channels, 22);
  h.writeUInt32LE(pcm.sampleRate, 24); h.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28); h.writeUInt16LE(pcm.channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.data.length, 40);
  return Buffer.concat([h, pcm.data]);
}

function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out;
}

const silence = (sampleRate: number, seconds: number, channels = 1) => Buffer.alloc(Math.round(sampleRate * seconds) * 2 * channels);

/** Split text into chunks of at most `max` chars at paragraph, then sentence boundaries. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (const para of text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
    if (para.length <= max) { chunks.push(para); continue; }
    let cur = "";
    for (const sentence of para.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) ?? [para]) {
      if ((cur + sentence).length > max && cur) { chunks.push(cur.trim()); cur = ""; }
      if (sentence.length > max) { for (let i = 0; i < sentence.length; i += max) chunks.push(sentence.slice(i, i + max)); continue; }
      cur += sentence;
    }
    if (cur.trim()) chunks.push(cur.trim());
  }
  return chunks;
}

/* ---------------------------------------------------------------- Kokoro */

const KOKORO_VOICES: [string, string, "en-us" | "en-gb", "Female" | "Male", string][] = [
  ["af_heart", "Heart", "en-us", "Female", "A"], ["af_bella", "Bella", "en-us", "Female", "A-"], ["af_nicole", "Nicole", "en-us", "Female", "B-"],
  ["af_aoede", "Aoede", "en-us", "Female", "C+"], ["af_kore", "Kore", "en-us", "Female", "C+"], ["af_sarah", "Sarah", "en-us", "Female", "C+"],
  ["af_alloy", "Alloy", "en-us", "Female", "C"], ["af_nova", "Nova", "en-us", "Female", "C"], ["af_sky", "Sky", "en-us", "Female", "C-"],
  ["af_jessica", "Jessica", "en-us", "Female", "D"], ["af_river", "River", "en-us", "Female", "D"],
  ["am_fenrir", "Fenrir", "en-us", "Male", "C+"], ["am_michael", "Michael", "en-us", "Male", "C+"], ["am_puck", "Puck", "en-us", "Male", "C+"],
  ["am_echo", "Echo", "en-us", "Male", "D"], ["am_eric", "Eric", "en-us", "Male", "D"], ["am_liam", "Liam", "en-us", "Male", "D"],
  ["am_onyx", "Onyx", "en-us", "Male", "D"], ["am_santa", "Santa", "en-us", "Male", "D-"], ["am_adam", "Adam", "en-us", "Male", "F+"],
  ["bf_emma", "Emma", "en-gb", "Female", "B-"], ["bf_isabella", "Isabella", "en-gb", "Female", "C"], ["bf_alice", "Alice", "en-gb", "Female", "D"],
  ["bf_lily", "Lily", "en-gb", "Female", "D"], ["bm_george", "George", "en-gb", "Male", "C"], ["bm_fable", "Fable", "en-gb", "Male", "C"],
  ["bm_lewis", "Lewis", "en-gb", "Male", "D+"], ["bm_daniel", "Daniel", "en-gb", "Male", "D"],
];

type KokoroModel = {
  // NOTE: kokoro-js 1.2.x never closes its internal splitter when given a plain string,
  // so stream(string) hangs after the last sentence. Always pass a closed TextSplitterStream.
  stream(text: unknown, opts: { voice: string; speed: number }): AsyncIterable<{ text: string; audio: { audio: Float32Array; sampling_rate: number } }>;
  model?: { dispose?: () => Promise<unknown> };
};

// Kept process-wide so a dev recompile can't load a second model (RAM) or lose the one-at-a-time queue.
const K = processState("kokoro", () => ({
  model: null as Promise<KokoroModel> | null,
  Splitter: null as (new () => { push(...t: string[]): void; close(): void }) | null,
  busy: Promise.resolve() as Promise<unknown>,
  unloadTimer: null as ReturnType<typeof setTimeout> | null,
}));
const KOKORO_IDLE_UNLOAD_MS = 10 * 60_000;

function loadKokoro(onProgress: (msg: string) => void): Promise<KokoroModel> {
  if (!K.model) {
    K.model = (async () => {
      const [{ KokoroTTS, TextSplitterStream }, transformers] = await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
      K.Splitter = TextSplitterStream;
      transformers.env.cacheDir = path.join(dataRoot(), "models"); // keep the ~90 MB model with app data, not node_modules
      // fp32 is ~2× faster than q8 on CPUs without VNNI (e.g. older Intel laptops); q8 uses half the RAM.
      const dtype = (env("KOKORO_DTYPE") || "fp32") as "fp32" | "fp16" | "q8" | "q4" | "q4f16";
      let last = -10;
      const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype, device: "cpu",
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (p.status === "progress" && typeof p.progress === "number" && p.progress - last >= 10) {
            last = p.progress;
            onProgress(`Downloading Kokoro voice model (first use only, ~${dtype === "fp32" ? "330" : "90"} MB)… ${Math.round(p.progress)}%`);
          }
        },
      });
      return tts as unknown as KokoroModel;
    })();
    K.model.catch(() => { K.model = null; });
  }
  return K.model;
}

function scheduleKokoroUnload() {
  if (K.unloadTimer) clearTimeout(K.unloadTimer);
  K.unloadTimer = setTimeout(async () => {
    const m = K.model;
    K.model = null;
    try { await (await m)?.model?.dispose?.(); } catch { /* ignore */ }
  }, KOKORO_IDLE_UNLOAD_MS);
}

const kokoroProvider: AudioProvider = {
  info: () => ({
    kind: "audio", id: "kokoro", label: "Kokoro (local, English)", vendor: "Runs on this computer", model: `Kokoro-82M v1.0 (${env("KOKORO_DTYPE") || "fp32"})`,
    configured: true, billing: "free-allocation",
    costNote: "Free and unlimited — runs on your CPU. First use downloads the model (~330 MB fp32). Uses about 0.8–1 GB RAM while generating and unloads after 10 idle minutes. On older laptop CPUs it renders roughly 3× slower than real time (a 5-minute narration ≈ 15 minutes), in the background.",
    requirements: [], setup: "Nothing to configure. Optional KOKORO_DTYPE: fp32 (default, faster on most CPUs) or q8 (half the RAM, ~90 MB download; faster only on CPUs with VNNI).",
    conditioning: "Apache-2.0 model weights (commercial use allowed). English only (US and UK voices).",
    caps: {
      languages: ["English (US)", "English (UK)"],
      voices: KOKORO_VOICES.map(([id, name, lang, gender, grade]): VoiceOption => ({ id, label: `${name} — ${gender.toLowerCase()}, ${lang === "en-us" ? "US" : "UK"} (grade ${grade})`, language: lang, gender, quality: grade })),
      speed: { min: 0.5, max: 2, default: 1 }, style: false, inlineTags: [], maxChars: 20000, runsLocally: true,
    },
  }),
  estimate: job => `Free (local). About ${Math.max(1, Math.round(job.text.split(/\s+/).length / 150))} min of speech.`,
  async generate(job, onProgress) {
    const voice = KOKORO_VOICES.find(v => v[0] === job.settings.voice)?.[0];
    if (!voice) throw new ProviderError("Unknown Kokoro voice.", 400);
    const speed = Math.min(2, Math.max(0.5, job.settings.speed ?? 1));
    // One local job at a time: protects RAM/CPU on small machines.
    const run = K.busy.then(async () => {
      if (K.unloadTimer) clearTimeout(K.unloadTimer);
      onProgress("Loading Kokoro…");
      const tts = await loadKokoro(onProgress);
      const Splitter = K.Splitter;
      if (!Splitter) throw new ProviderError("Kokoro failed to initialise.", 500);
      const paragraphs = chunkText(job.text, 2000);
      const parts: Buffer[] = [];
      let sampleRate = 24000, seconds = 0;
      const estTotal = Math.max(1, Math.round(job.text.split(/\s+/).length / 2.5 / speed)); // ~150 wpm
      for (const [pi, para] of paragraphs.entries()) {
        const splitter = new Splitter();
        splitter.push(para);
        splitter.close();
        let first = true;
        for await (const chunk of tts.stream(splitter, { voice, speed })) {
          sampleRate = chunk.audio.sampling_rate;
          if (!first) parts.push(silence(sampleRate, 0.12));
          parts.push(floatToPcm16(chunk.audio.audio));
          seconds += chunk.audio.audio.length / sampleRate;
          first = false;
          onProgress(`Speaking… ${Math.round(seconds)}s of about ${estTotal}s rendered`);
        }
        if (pi < paragraphs.length - 1) parts.push(silence(sampleRate, 0.45));
      }
      if (!parts.length) throw new ProviderError("Kokoro produced no audio — is the text empty?", 400);
      return encodeWav({ sampleRate, channels: 1, data: Buffer.concat(parts) });
    });
    K.busy = run.catch(() => {});
    try {
      return { data: await run, mimeType: "audio/wav", notes: "" };
    } finally {
      scheduleKokoroUnload();
    }
  },
};

/* ------------------------------------------------------------ Gemini TTS */

const GEMINI_VOICES: [string, string][] = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"], ["Fenrir", "Excitable"], ["Leda", "Youthful"],
  ["Orus", "Firm"], ["Aoede", "Breezy"], ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"], ["Enceladus", "Breathy"], ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"], ["Erinome", "Clear"], ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"],
  ["Laomedeia", "Upbeat"], ["Achernar", "Soft"], ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"], ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"], ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
];
const GEMINI_TAGS = ["<laugh>", "<sigh>", "<short pause>", "<long pause>", "<cough>", "<whisper>"];

const geminiTts: AudioProvider = {
  info: () => ({
    kind: "audio", id: "gemini-tts", label: "Gemini TTS (cloud, multilingual)", vendor: "Google AI Studio",
    model: env("GEMINI_TTS_MODEL") || "gemini-3.8-flash-tts",
    configured: !!env("GEMINI_API_KEY"), billing: "free-allocation",
    costNote: "Free tier on the Gemini API (daily limits are not published; you'll see a 429 error when reached). On the free tier Google may use inputs to improve its products. Paid tier ≈ $0.002 per 10 s of speech.",
    requirements: ["GEMINI_API_KEY"], setup: "Same GEMINI_API_KEY as chat. Optional GEMINI_TTS_MODEL (gemini-3.8-flash-tts or gemini-3.8-flash-lite-tts).",
    conditioning: "Very natural voices in 100+ languages including Hindi (language is detected automatically). Supports a delivery/style instruction and inline tags like <laugh>.",
    caps: {
      languages: ["Hindi", "English", "100+ more (auto-detected)"],
      voices: GEMINI_VOICES.map(([id, tone]): VoiceOption => ({ id, label: `${id} — ${tone}`, language: "multilingual", gender: "Neutral" })),
      speed: null, style: true, inlineTags: GEMINI_TAGS, maxChars: 20000, runsLocally: false,
    },
  }),
  estimate: () => "Free tier (rate-limited).",
  async generate(job, onProgress) {
    const key = env("GEMINI_API_KEY");
    if (!key) throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to .env.local.", 400);
    if (!GEMINI_VOICES.some(v => v[0] === job.settings.voice)) throw new ProviderError("Unknown Gemini voice.", 400);
    const model = geminiTts.info().model;
    const chunks = chunkText(job.text, 2500);
    const pcm: Buffer[] = [];
    let sampleRate = 24000, channels = 1;
    for (const [i, text] of chunks.entries()) {
      onProgress(`Generating speech with Gemini… part ${i + 1}/${chunks.length}`);
      const content: Record<string, unknown> = { type: "text", text };
      if (job.settings.style?.trim()) content.annotations = [{ type: "speech_metadata", style: job.settings.style.trim().slice(0, 500) }];
      const { status, text: body } = await postJsonLong("https://generativelanguage.googleapis.com/v1beta/interactions",
        { "x-goog-api-key": key },
        { model, store: false, input: [{ type: "user_input", content: [content] }], response_format: { type: "audio", mime_type: "audio/wav" }, generation_config: { speech_config: [{ voice: job.settings.voice }] } },
        5 * 60_000);
      if (status < 200 || status >= 300) throw explainHttpError("Gemini TTS", status, errorDetail(body));
      const data = JSON.parse(body) as { steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string }[] }[] };
      const audio = (data.steps ?? []).filter(s => s.type === "model_output").flatMap(s => s.content ?? []).filter(c => c.type === "audio" && c.data).at(-1);
      if (!audio?.data) throw new ProviderError("Gemini returned no audio for part " + (i + 1) + ".", 502);
      const bytes = Buffer.from(audio.data, "base64");
      const parsed = (audio.mime_type ?? "audio/wav").includes("l16") ? { sampleRate: 24000, channels: 1, data: bytes } : parseWav(bytes);
      sampleRate = parsed.sampleRate;
      channels = parsed.channels;
      if (i > 0) pcm.push(silence(sampleRate, 0.35, channels));
      pcm.push(parsed.data);
    }
    return { data: encodeWav({ sampleRate, channels, data: Buffer.concat(pcm) }), mimeType: "audio/wav", notes: "" };
  },
};

const PROVIDERS: AudioProvider[] = [kokoroProvider, geminiTts];

export function audioProviders(): AudioProvider[] {
  return PROVIDERS;
}

export function audioProvider(id: string): AudioProvider | undefined {
  return PROVIDERS.find(p => p.info().id === id);
}
