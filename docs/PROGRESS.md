# Wonderboy AI Studio — Progress

## Product direction
A private AI filmmaking workspace combining an AI creative companion, scriptwriting, shot planning, character/location continuity, image generation and video generation. Used to produce videos for a monetized YouTube channel on a small budget: free tiers where possible, otherwise pay only for rented GPU time running open, commercially licensed models.

## Implemented
- [x] Next.js + TypeScript application scaffold, ESLint flat config
- [x] Dark cinematic responsive interface: pinned sidebar, sticky topbar, only main content scrolls; mobile sticky nav strip; tokenised typography scale
- [x] **Persistent local storage:** project documents and uploaded files on disk under `data/projects/<id>/` (atomic writes, `.bak` copy, revision-based conflict detection)
- [x] One-time import of the previous browser-only (localStorage) project, converting base64 images to uploaded files
- [x] **Project management:** create, open/switch (sidebar switcher), rename, delete (with files)
- [x] **Project dashboard:** counts, progress bars computed from data (shots done / fully specified / continuity-linked, characters & locations with references), shot status breakdown, recent activity log
- [x] **Script studio:** multiple scripts per project, screenplay editor, scenes with slugline, title, description, dialogue/action, characters and location; reorder/delete scenes; create scenes from INT./EXT. sluglines
- [x] **Scene & shot planner:** shots per scene with derived numbers (e.g. 2.3), description, framing, camera angle, camera movement, lighting, mood, duration, status, notes; edit, reorder, duplicate, delete, move between scenes; unassigned shots
- [x] **Character library:** name, description, physical appearance, clothing, personality, notes; multiple identity reference images with a primary image; wardrobe/appearance variations with their own images
- [x] **Location library:** description, architecture, environment, layout, lighting, must-not-change visual details; multiple master reference images; named camera angles with their own images
- [x] **Asset library:** upload images/videos/audio/documents; search, type filter, unused filter; rename, tags, notes; "used by" list; link to characters, variations, locations, angles and shots; unlink; download; delete (file removed from disk)
- [x] **Continuity management:** shots link characters (+ wardrobe variation), location (+ camera angle) and extra reference files; persistent reference records; structured `ContinuityBundle` (src/lib/continuity.ts) used to choose and send reference images
- [x] Project JSON export

### AI engine
- [x] Provider-independent AI layer (server-side adapters with capability descriptors, `/api/providers` status)
- [x] **AI Companion:** multi-turn chat persisted per project (multiple conversations), live project context, scene focus, mic dictation and spoken replies (browser speech APIs), proposals reviewed before applying
- [x] **AI Script Assistant:** story ideas, loglines, outline, complete script, improve script, scene breakdown, rewrite dialogue, improve scene, shot list, character/location suggestions; review/apply with confirmation before any overwrite
- [x] **Text-to-image / image-to-image** with aspect ratio, size, steps, seed, guidance, count; outputs saved to the asset library and linked to the shot as takes; regenerate / iterate / use as source
- [x] **Reference-conditioned generation:** shot characters (+ wardrobe), location (+ angle) and shot references sent as real images to models that support it; text-only models clearly labelled
- [x] **Image-to-video / text-to-video** with duration, aspect ratio, resolution; start frame from generated or uploaded images; saved to project + shot
- [x] Generation jobs with status, progress, errors, retry; paid providers require explicit cost approval (enforced server-side)

- [x] **Voice Studio (text-to-speech):** narration/dialogue to WAV, load text from scenes, attach to a shot, voice + speed (Kokoro) or style direction + expressive tags (Gemini), history with players, download, retry; outputs saved to the asset library and shot takes
- [x] **Free local TTS:** Kokoro-82M on the CPU (English, unlimited, Apache-2.0), tested end to end
- [x] Hindi TTS via Gemini 3.8 Flash TTS (free tier), with automatic Hindi detection in the UI

- [x] **Story Cuts:** narrated stories over existing footage (free stock clips, public-domain films). ffmpeg scene detection (range + sensitivity, short scenes merged, long ones split, keyframes) → AI scene descriptions from keyframes (Gemini vision, batched, partial results kept) → AI story with per-scene word budgets in 7 styles + custom direction (editable, reorder/skip scenes) → Kokoro voiceover (cached per line) + ffmpeg render to 1080p30 MP4 with film audio ducked under the voice; saved to the asset library
- [x] **Story Cuts script mode ("I have a script"):** paste a narration script → AI suggests a cast (script character = recurring person in the footage, editable) → AI splits the script into lines and picks up to 3 matching scenes per line (no scene used twice as first pick) → swap via suggestions or a scene picker, edit/reorder/add lines → render follows the voice (each line's scene trimmed or run on). Using one film keeps characters consistent
- [x] **Your GPU (ComfyUI) image providers:** Z-Image Turbo (fast text-to-image, up to 1920×1088) and Qwen-Image-Edit 2511 (up to 3 reference/source pictures, fast Lightning mode or full steps). No per-image cost
- [x] **Settings → ComfyUI GPU:** paste the pod address (saved in `data/settings.json`, no restart), optional auth header, connection test showing GPU, VRAM, ComfyUI version and missing model files with copyable download commands

### Integration status (see docs/PROVIDERS.md)
| Integration | Status |
|---|---|
| Gemini text (chat + assistant) | Implemented; works once `GEMINI_API_KEY` is set (free tier). Not yet run against a live key |
| OpenAI-compatible text (HF router, Groq, OpenRouter, Cloudflare) | Implemented; generic, not live-tested |
| Cloudflare FLUX.2 klein/dev (references) and FLUX.1 schnell | Implemented; error path verified with fake credentials; needs a real token to confirm success path |
| Gemini Nano Banana image (paid) | Implemented against current Interactions API docs; needs billing; not live-tested |
| Gemini Omni Flash video (paid) | Implemented against current docs; needs billing; not live-tested |
| fal.ai Kling / Wan video (paid) | Implemented against queue API docs; needs credits; not live-tested |
| Hugging Face Inference Providers (images/video) | Not implemented (no free credits for free accounts since Oct 2026); HF usable for text via OpenAI-compatible |
| Kokoro local TTS (English) | **Working** — verified end to end (12.9 s WAV in 44 s incl. model load on an i5-7200U, ~1 GB peak RAM) |
| Gemini TTS (Hindi + multilingual, free tier) | Implemented against current docs; not live-tested |
| ComfyUI on your GPU (Z-Image Turbo, Qwen-Image-Edit 2511) | Implemented against the official ComfyUI templates; tested against a simulated ComfyUI server; **not yet run on a real GPU** |
| Story Cuts (ffmpeg + Gemini vision + Kokoro), story and script modes | Detect, render (both modes, silent sources, voice cache) verified end to end on synthetic clips; describe/cast/match/story verified against a mock OpenAI-compatible model; **Gemini not live-tested** |
| Free video generation | Unavailable — no integrated provider offers it |

## Next: self-hosted GPU generation (step 1 built)
Decided Nov 2026. Goal: generate images and video with **open, commercially licensed models on a rented GPU**, paying only for GPU time instead of per-image/per-second API fees. Output is for a **monetized YouTube channel**, so licences must allow commercial use. Budget: **$50/month max** for now (may grow with channel revenue).

- [ ] **Setup (with the user, once):** RunPod account with prepaid credit ($10–20 at a time, auto-reload off), ~100 GB network volume for models, ComfyUI pod, model download script
- [x] **"Your GPU" provider (ComfyUI adapter), images:** Z-Image Turbo text-to-image + Qwen-Image-Edit 2511 reference editing, in the existing Image Studio, job system and shot takes
- [ ] First real session on RunPod: verify workflows, measure speed and cost per image
- [ ] ComfyUI video: Wan 2.2 image-to-video / text-to-video
- [ ] **Secured connection** to ComfyUI (it has no built-in auth)
- [ ] **GPU cost controls in the app:** start/stop pod with hourly price shown, live session cost meter, auto-stop after 15 idle minutes, monthly budget cap that blocks starting the GPU once reached
- [ ] **Per-character LoRA training** on the rented GPU (most reliable consistency; later phase)
- [ ] Optional later: RunPod Serverless (no idle cost) once usage is steady

Planned models (all Apache 2.0 — licences to be re-verified before download):
| Job | Model |
|---|---|
| Images | Z-Image Turbo (built), Qwen-Image |
| Consistency edits with multiple reference images | Qwen-Image-Edit |
| Image-to-video / text-to-video | Wan 2.2 |
| Free quick drafts | FLUX.1 [schnell] / Cloudflare (already integrated) |

Avoid models whose licences restrict commercial use (e.g. FLUX dev-class weights) for production work.

Budget estimate (to be replaced by real numbers after the first session): ~$7/month model storage + ~$40 GPU time (RTX 4090 ≈ $0.34–0.69/hr) ≈ 60–100 GPU hours; ≈ $3–8 per YouTube video (≈150 images + 40 five-second clips) → ≈ 5–10 videos/month. Free tiers stay in use: Gemini for chat/scripts, Cloudflare for drafts. Paid APIs (Gemini image/Omni, fal.ai) remain optional, opt-in fallbacks.

## Not yet implemented
- [ ] Live verification of each provider adapter with real credentials
- [ ] Guaranteed visual consistency (not claimed; would need identity training/LoRAs or stronger models)
- [ ] Cancel running generation jobs; durable job queue that survives server restarts
- [ ] Streaming chat responses
- [ ] Project import (JSON + files) and full backup/restore
- [ ] Orphaned upload cleanup
- [ ] Voice conversation / realtime audio
- [ ] Timeline editor and export pipeline
- [ ] Authentication, multi-user, cloud storage and deployment
- [ ] Automated tests

## Important limitations
This is a functional single-user local workspace, not a finished production system. Data is stored on the machine running the server (`data/`, git-ignored) and should be backed up manually. AI generation runs only with your own provider keys; paid providers ask for approval every time and no free video option exists. Saving the same project from two tabs is detected (conflict banner) but not merged. Do not put API keys in client-side code.

## Development rule
Update this file after every meaningful change. Keep provider integrations behind server-side adapters. Never trigger paid GPU inference without an explicit user action and clear cost indication.
