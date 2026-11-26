# AI providers — setup, costs and status

Wonderboy calls AI providers **only from the server** (`src/lib/server/ai/*`). Keys live in `.env.local`, never in the browser. After editing `.env.local`, restart `npm run dev` and press **Settings → AI providers → Refresh** to see the live status.

Research for this guide was done in November 2026, and provider offerings change often. Check each provider's pricing page before relying on a free tier.

## Quick start (free)

1. **Text AI (chat + script assistant).** Create a key at <https://aistudio.google.com> → *Get API key*, then set `GEMINI_API_KEY=`. Current Flash text models have a free tier with rate limits.
2. **Images.** Create a Cloudflare account (no payment method needed for the Free plan). Go to Dashboard → *AI* → *Workers AI* → *Use REST API*, copy the **Account ID**, and create an **API token** with Workers AI permission. Then set `CLOUDFLARE_ACCOUNT_ID=` and `CLOUDFLARE_API_TOKEN=`.
3. Restart the server.

That gives you working chat, the script assistant, and reference-conditioned image generation, all within free allocations. **There is no free video option** (see below).

## Your own GPU: ComfyUI (unlimited images, pay per hour)

Wonderboy can send image jobs to **ComfyUI running on a GPU you rent** (e.g. RunPod). There is no per-image fee: you pay the GPU host by the hour while the pod runs. **Wonderboy does not start or stop the pod yet** (that is step 2 of the roadmap), so stop it on RunPod when you're done.

| Provider (id) | Model | Licence | What it does |
|---|---|---|---|
| **Z-Image Turbo** (`comfyui-z-image`) | Z-Image-Turbo 6B, 8 steps | Apache-2.0 (official model card) | Fast, photorealistic **text-to-image**. 1K (≈1 MP) or 2K (16:9 = 1920×1088). Text-only: references are not used |
| **Qwen-Image-Edit 2511** (`comfyui-qwen-edit`) | Qwen-Image-Edit-2511 20B (fp8mixed) + Lightning 4-step LoRA | Apache-2.0 (model); LoRA licence not yet verified | **Reference-conditioned**: up to 3 pictures (source image, then character/location references). 4–8 steps = fast mode with the LoRA (CFG 1); 9–40 steps = full model (CFG applies, slower) |

### Setup (once)
1. **RunPod:** create an account and add prepaid credit ($10 is enough to start) with **auto-reload off**. That is your hard spending limit.
2. **Network volume** (≈ 60–80 GB) in the same region as the GPU you want, so models are downloaded once (≈ $0.07/GB/month, about $4–6/month).
3. **Deploy a pod** on an RTX 4090 or 5090 (24–32 GB VRAM) with a **ComfyUI template** and the network volume attached. When it's running, open *Connect* and copy the HTTP address for port 8188: `https://<pod-id>-8188.proxy.runpod.net`.
4. **Wonderboy → Settings → ComfyUI GPU:** paste the address, then **Save address**. Wonderboy tests the connection and lists missing model files with ready-to-copy `wget` commands.
5. **Download the models:** open the pod's web terminal, `cd` into the ComfyUI folder (on the network volume), paste the commands, and wait. Then refresh ComfyUI and press **Test connection** again.

| File | Folder | Size | Needed for |
|---|---|---|---|
| `z_image_turbo_bf16.safetensors` | `diffusion_models` | 11.5 GB | Z-Image |
| `qwen_3_4b.safetensors` | `text_encoders` | 7.5 GB | Z-Image |
| `ae.safetensors` | `vae` | 0.3 GB | Z-Image |
| `qwen_image_edit_2511_fp8mixed.safetensors` | `diffusion_models` | ≈ 20 GB | Qwen-Edit |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `text_encoders` | 8.7 GB | Qwen-Edit |
| `qwen_image_vae.safetensors` | `vae` | 0.24 GB | Qwen-Edit |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `loras` | 0.8 GB | Qwen-Edit fast mode |

### How it works
- Workflows follow ComfyUI's official templates (Z-Image Turbo: `lumina2` text encoder, AuraFlow shift 3, 8 steps, CFG 1, `res_multistep`; Qwen-Image-Edit-2511: `TextEncodeQwenImageEditPlus`, CFGNorm, `index_timestep_zero` reference method, euler/simple).
- Before each job Wonderboy reads `/object_info` from your ComfyUI: it checks the model files exist (clear error if not) and fills defaults for any inputs newer ComfyUI versions add.
- References are uploaded with `/upload/image`, the job is queued with `/prompt`, progress comes from `/queue` + `/history`, and the image is downloaded from `/view`.
- Tested against a simulated ComfyUI server (upload, queue, progress, download, missing models, unreachable pod). **Not yet run on a real GPU**; the first real session is the real test, and speeds in the UI are estimates until then.

### Security
ComfyUI has **no login**. RunPod's proxy address is hard to guess but public: anyone who has it can use your GPU while the pod runs. Don't share it, stop the pod when idle, and if you put ComfyUI behind an authenticating proxy, add its header in Settings (stored only in `data/settings.json` on your computer and never sent to the browser).

## Story Cuts (narrated stories over footage)
- **ffmpeg** (free, local) does scene detection and rendering: `sudo apt install ffmpeg`.
- **Scene descriptions and story writing** use the text AI (Gemini free tier via `GEMINI_API_KEY`, or an OpenAI-compatible model that accepts images). Keyframes (small JPEGs) are sent to the provider; on Gemini's free tier, Google may use inputs to improve its products. A 100-scene film is about 10 description requests plus 1 story request.
- **Voice:** any configured voice engine (Kokoro by default: local and free).
- **Stock clips (Pexels):** free API key from pexels.com/api → `PEXELS_API_KEY`. 200 requests/hour, 20,000/month. Pexels licence: free for commercial use and modification; attribution not required but appreciated (Wonderboy lists credits to copy into the video description). Not allowed: showing identifiable people in a bad or offensive light, implying endorsement, reselling unaltered clips. Movie/TV/celebrity references in your notes are turned into generic searches; stock sites don't carry them.
- **Footage:** use footage you may monetize (Pexels/Pixabay stock, public-domain films). Copyrighted movie clips are usually claimed by YouTube's Content ID.

## Voice (text-to-speech)

| Engine (id) | Languages | Cost | Licence | Status |
|---|---|---|---|---|
| **Kokoro-82M, local** (`kokoro`) | English (US + UK), 28 voices (best: Heart, Bella; UK: Emma) | **Free, unlimited, offline** | Apache-2.0 weights: commercial use OK | **Working**, tested end to end on this laptop |
| **Gemini 3.8 Flash TTS** (`gemini-tts`) | 100+ incl. **Hindi** (auto-detected), 30 voices, style direction, tags like `<laugh>` | Free tier (daily limits unpublished; 429 when reached). Free-tier inputs may be used by Google | Google API terms | Implemented against current docs; needs `GEMINI_API_KEY`; not live-tested |

- Kokoro runs inside the Wonderboy server process on the CPU: one job at a time, about 0.8–1 GB RAM while generating, unloaded after 10 idle minutes.
- First use downloads the model to `data/models` (~330 MB for fp32, the default; ~90 MB for q8).
- Measured on an Intel i5-7200U: fp32 renders about 2.7× slower than real time (a 5-minute narration ≈ 15 minutes in the background), and q8 was about 2× slower again. Set `KOKORO_DTYPE=q8` only to save RAM.
- `kokoro-js` only ships English phonemization, so Hindi goes to Gemini TTS. The Voice Studio detects Devanagari text and offers to switch.
- Ruled out for commercial YouTube use: F5-TTS (CC-BY-NC), XTTS-v2 (Coqui non-commercial licence) and the ElevenLabs free tier (no commercial use). Chatterbox is unmaintained.
- **Install note:** `onnxruntime-node` tries to download CUDA binaries during `npm install` (that download 404s, and the GPU build isn't needed). `.npmrc` sets `onnxruntime-node-install-cuda=skip`. If a future npm ignores that key, install with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install`.

## What is implemented

| Area | Provider (id) | Model(s) | Cost | References / conditioning | Status |
|---|---|---|---|---|---|
| Text | Gemini (`gemini`) | `gemini-3.8-flash` (override `GEMINI_TEXT_MODEL`) via `generateContent` | Free tier (rate-limited) | n/a | Implemented; needs your key to run |
| Text | OpenAI-compatible (`openai-compatible`) | `LLM_MODEL` at `LLM_BASE_URL` | Depends on service | n/a | Implemented; generic |
| Image | Cloudflare FLUX.2 [klein] 9B (`cloudflare-flux-2-klein`) | `@cf/black-forest-labs/flux-2-klein-9b` | Free 10,000 neurons/day (≈7 images/day); then Workers Paid $0.011/1k neurons | **Up to 4 reference images** (sent below 512×512), image-to-image | Implemented; needs Cloudflare token |
| Image | Cloudflare FLUX.2 [dev] (`cloudflare-flux-2-dev`) | `@cf/black-forest-labs/flux-2-dev` | Same allocation; ≈2–3 images/day | Up to 4 references, image-to-image | Implemented |
| Image | Cloudflare FLUX.1 [schnell] (`cloudflare-flux-1-schnell`) | `@cf/black-forest-labs/flux-1-schnell` | Very cheap, many/day | **Text-only** (references ignored; square only) | Implemented |
| Image | Gemini Nano Banana (`gemini-image`) | `gemini-nano-banana-2.1` (override `GEMINI_IMAGE_MODEL`: `gemini-3.1-flash-image`, `gemini-3-pro-image`) via Interactions API | **Paid only**, ≈$0.034 (1K) – $0.24 (4K Pro) per image | **Up to 14 labelled references** (≤4 character + ≤10 object), image editing | Implemented; needs billing |
| Video | Gemini Omni Flash (`gemini-omni`) | `gemini-omni-1.2-flash` via Interactions API | **Paid only**, ≈$0.07/s at 720p ($0.023 360p … $0.209 4K) | Text-to-video, image-to-video (start frame), reference-to-video (≤6 images) | Implemented; needs billing |
| Video | fal.ai (`fal`) | `fal-ai/kling-video/v3/standard/image-to-video` + `fal-ai/wan/v2.2-a14b/text-to-video` | **Paid** prepaid credits, Kling ≈$0.14/s | Image-to-video from one start frame; Wan text-only | Implemented; needs `FAL_KEY` + credits |

"Implemented" means the adapter is written against each provider's current documented REST API and handles errors. None of these were run against live accounts during development, because no keys were configured. The first real call for each provider is the real test. If a provider changed a field, the error message from the provider is shown in the UI.

### Options investigated and not used (yet)
- **Hugging Face Inference Providers:** free accounts no longer receive monthly inference credits (removed October 2026), and usage is billed at each partner provider's rate. You can still use HF for text through the OpenAI-compatible adapter (`LLM_BASE_URL=https://router.huggingface.co/v1`). A public model page is not a promise of free hosted inference.
- **Veo 3.1 previews and Imagen 4** on the Gemini API are shut down; Google points to Omni Flash and Nano Banana instead.
- **Modal / self-hosted GPUs:** deliberately not used. No GPU server is required.

## Consistency: what is (and isn't) guaranteed

- Reference-conditioned models (FLUX.2, Nano Banana, Omni) receive the **actual reference images** for the shot's characters (identity images, primary first, then the selected wardrobe variation), its location (camera angle first) and the shot's own references. Each image is labelled in the prompt.
- This **improves** consistency of faces, hairstyle, clothing, body, architecture, layout and key objects. **It does not guarantee it.** Expect to iterate: regenerate, use a good result as the source image (image-to-image), or add it back as a reference.
- Text-only models (FLUX.1 schnell, Wan text-to-video) use descriptions alone, which is **not** reliable for consistency. The UI labels them as text-only.
- For video, the most consistent workflow is: generate a reference-conditioned frame → **Animate** it (image-to-video).

## Cost safety

- Paid providers show the estimated cost, require an explicit confirmation in the browser, and the server rejects paid requests without `approvedPaid: true`.
- Nothing is generated on page load or in the background without a click.
- Cloudflare's free plan cannot overspend: requests fail with 429 once the daily allocation is used (resets 00:00 UTC). On Workers **Paid**, usage above the allocation is billed.
- Failures show the provider's own message (401 bad key, 402 billing, 404 model retired, 429 quota). Wonderboy does not retry paid jobs automatically. Use **Retry with these settings**.

## Self-hosted GPU (main direction)

Paying per image or per second through APIs is expensive at YouTube volumes. The chosen direction is to **rent a GPU by the hour and run open models with ComfyUI**, with Wonderboy talking to it as a provider. Status: **step 1 built** (ComfyUI image providers above). Video on the GPU and in-app start/stop/cost controls are next (see docs/PROGRESS.md).

| | Paid API (integrated) | Rented GPU + open models (planned) |
|---|---|---|
| Image | $0.03–0.24 each | ≈ $0.002–0.005 each (Qwen-Image / FLUX-class on an RTX 4090) |
| 5 s video clip | ≈ $0.35–0.70 | ≈ $0.05–0.30 (Wan 2.2; estimate) |
| GPU rental | — | RTX 4090 ≈ $0.34–0.69/hr, A100 ≈ $1.19–2.09/hr on RunPod (Nov 2026; Vast.ai often cheaper but less reliable) |

Decisions:
- **Provider:** RunPod (per-second billing, ComfyUI templates, network volumes). Prepaid credit with auto-reload **off** is the hard spending limit.
- **Models:** commercially usable licences only, because output is monetized on YouTube: Qwen-Image, Qwen-Image-Edit, Wan 2.2 (Apache 2.0, to be re-verified). No FLUX dev-class weights for production.
- **Cost safety in the app:** explicit Start GPU with price shown, live cost meter, auto-stop when idle, monthly budget cap ($50 for now).
- **Consistency:** reference-image editing first. Per-character LoRA training on the same GPU later. Still not guaranteed.
- **Security:** ComfyUI has no authentication, so it must not be exposed openly. Access goes through an authenticated or tunnelled connection.

YouTube notes: realistic AI-generated content must be disclosed when uploading, and mass-produced, repetitive AI content isn't eligible for monetization. Original, story-driven work is the intended use.

## Adding or switching providers

- **Switching models:** use the env overrides above (`GEMINI_*_MODEL`, `FAL_*_MODEL`, `LLM_*`).
- **New image provider:** implement `ImageProvider` (`info()` with honest `caps`, `estimate()`, `generate()`) in `src/lib/server/ai/image.ts` and add it to `PROVIDERS`. The UI, validation and job system pick it up automatically.
- **New video provider:** same, with `VideoProvider` in `src/lib/server/ai/video.ts`.
- **New text provider:** add an `LlmProvider` in `src/lib/server/ai/llm.ts`.
- Adapters receive references already downscaled to `caps.referenceMaxSide` / `caps.imageMaxSide` as base64 JPEG. They must return raw bytes; the job runner stores the files and links them to the project.
