# CLAUDE.md — Wonderboy AI Studio

Guidance for Claude Code (and humans) working in this repository. It describes the code **as it exists today**. When something here disagrees with the code, the code wins: fix this file.

## What this is

Wonderboy AI Studio is a private, single-user **AI filmmaking studio**. It runs as a local Next.js app and is used in the browser. The workflow is:

**Project → Script → Scenes → Shots → characters & locations (with reference images) → prompt → generate image → generate video → saved to the project and its shot.**

Each project holds scripts, scenes, shots, a character library (identity + wardrobe variations + reference images), a location library (fixed details + camera angles + reference images), an asset library of files, AI conversations and a generation history.

The AI engine (all server-side, provider-independent):
- **AI Companion:** multi-turn chat, persisted per project, aware of the live project. It has mic dictation and spoken replies (browser Web Speech API), and returns **proposals** (scripts, scenes, shots, characters, locations, logline) that the user reviews before applying.
- **Script Assistant:** ideas, loglines, outlines, full scripts, script/scene improvement, dialogue rewrites, scene breakdowns, shot lists, character and location suggestions. All of these come back as reviewable proposals.
- **Image generation:** Cloudflare FLUX.2 (free daily allocation, up to 4 reference images), FLUX.1 schnell (text-only), Gemini Nano Banana (paid, up to 14 references). Supports image-to-image.
- **Video generation:** Gemini Omni Flash (paid: text-, image- and reference-to-video) and fal.ai (paid: Kling image-to-video, Wan text-to-video).
- **Voice (text-to-speech):** Kokoro-82M runs **locally on the CPU** (free, unlimited, English, Apache-2.0; tested and working). Gemini 3.8 Flash TTS covers Hindi and 100+ languages on the free tier.

See `docs/PROVIDERS.md` for setup, costs and per-integration status.

**Product direction (decided Nov 2026):** the output is for a **monetized YouTube channel** on a **$50/month budget**. Prefer free tiers. For real generation, the plan is to **rent a GPU (RunPod) and run open, commercially licensed models via ComfyUI** (Z-Image Turbo, Qwen-Image-Edit, Wan 2.2), paying only for GPU time. **Step 1 is built:** ComfyUI image providers that talk to a pod the user starts themselves (address pasted in Settings). Video on the GPU and in-app start/stop/cost controls are not built yet; see the roadmap in `docs/PROGRESS.md`. Rules that follow from it:
- Only use models whose licences allow commercial use for production features. Flag anything else.
- Never start a paid GPU or paid job without an explicit user action, with the price shown. GPU features must include idle auto-stop and respect the budget cap.
- Paid per-call APIs (Gemini image/Omni, fal.ai) stay as optional fallbacks, not the default path.

Other docs: `docs/PROGRESS.md` (feature status; update it after meaningful changes) and `docs/ARCHITECTURE.md` (continuity design).

## Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5 strict, alias `@/*` → `src/*` |
| Styling | One global stylesheet `src/app/globals.css` with custom-property tokens. No Tailwind or UI kit |
| Persistence | JSON documents + files on the local file system via Node `fs` (no database) |
| AI | Plain `fetch` / `node:https` REST calls to Gemini (generateContent + Interactions API), Cloudflare Workers AI, fal.ai queue, and any OpenAI-compatible endpoint. **No SDKs** |
| Voice | Browser `SpeechRecognition` + `speechSynthesis` |
| Lint | ESLint 9 flat config (`eslint.config.mjs`) |
| Runtime deps | `next`, `react`, `react-dom`, plus `kokoro-js` and `@huggingface/transformers` for local TTS (approved: free, offline speech). Add nothing else without a strong reason |
| Native/external | `next.config.ts` marks `kokoro-js`, `@huggingface/transformers`, `onnxruntime-node` and `phonemizer` as `serverExternalPackages`, because they load native binaries and package-relative files. `.npmrc` skips onnxruntime's CUDA download |

## Commands

```bash
npm install
cp .env.example .env.local   # add keys you need (see docs/PROVIDERS.md); app runs without them
npm run dev                  # http://localhost:3000
npm run lint
npx tsc --noEmit
npm run build
npm start
```

- **Desktop launcher (Linux):** `scripts/install-launcher.sh` installs `wonderboy.desktop` (menu + desktop) that runs `scripts/start-wonderboy.sh`: loads nvm's Node, rebuilds only if `src/`, `package.json` or `next.config.ts` is newer than `.next/BUILD_ID`, runs `next start` in the foreground (closing the terminal stops it), and opens the browser when ready. Port via `WONDERBOY_PORT`.
- **Tests:** there's no test suite. Verify with `npx tsc --noEmit`, `npm run lint` and `npm run build`. For API/storage changes, run a short `curl` smoke test against `npm start` with `WONDERBOY_DATA_DIR` set to a temp folder.
  - Start the server with `node_modules/.bin/next start`, not `npx` (killing `npx` leaves the server running), and confirm port 3000/3123 is free afterwards.
  - **Never** call paid providers in tests. Fake credentials are fine for exercising error paths.
- **Dev machine has 8 GB RAM.** No headless browsers, screenshot tools or long-lived background servers unless asked.
- `next dev` and `next start` both write `.next/`. Never run both at once.
- `.env.local` changes require a server restart.

## Folder structure

```
src/
  app/
    page.tsx                         Shell: sidebar (project switcher, nav), topbar (save state), banner, view routing
    globals.css                      All styles
    api/
      projects/route.ts              GET list · POST create
      projects/[id]/route.ts         GET · PUT (revision-checked) · DELETE
      projects/[id]/files/…          POST upload · GET [assetId] stream (Range)
      projects/[id]/generations/     GET history (+live progress) · POST start job
      projects/[id]/conversations/   GET · POST; [cid] PATCH/DELETE; [cid]/messages POST (chat turn)
      projects/[id]/assist/          POST script-assistant task → proposals
      comfyui/route.ts               GET status (?check=1 contacts ComfyUI) · PUT {url, authHeader?, clearAuth?}
      projects/[id]/storycuts/       jobs GET/POST (detect|describe|render|auto|stock) · story POST · script POST {action: cast|match} · stock POST {action: swap|search} · frames/[name] GET
      providers/route.ts             GET provider registry (status + capabilities, no secrets)
  components/
    studio.tsx                       StudioContext/useStudio, TABS, shared UI (fields, Modal, AssetPreview, ReferenceImages…)
    CompanionView.tsx                AI chat: conversations, voice in/out, proposals
    ProposalCard.tsx                 Review/apply UI for AI proposals (confirms before overwriting)
    ScriptStudio.tsx, ScriptAssistant.tsx
    ShotPlanner.tsx, ContinuityPicker.tsx, CharacterLibrary.tsx, LocationLibrary.tsx, AssetLibrary.tsx
    GenerationStudio.tsx             Image/Video Studio: provider, shot/refs, source/start frame, settings, jobs
    StoryCutStudio.tsx               Story Cuts: footage → scenes → AI descriptions → AI story → voice + MP4 render
    VoiceStudio.tsx                  Text-to-speech: engine/voice, speed or style, text from scenes, shot link, history
    DashboardView.tsx, ProjectsView.tsx, SettingsView.tsx (incl. AI providers panel)
  lib/
    types.ts                         Domain types
    projectModel.ts                  PURE: factories, normalizeProject, selectors, cascading mutations
    continuity.ts                    PURE: ContinuityBundle + prompt text for a shot / manual selection
    storyCut.ts                      PURE: story styles, word budget (2.4 words/s × speed), StoryJob types
    proposals.ts                     PURE: Proposal types, normalizeProposal(s), applyProposal, chat-block parsing
    ai/types.ts                      Shared AI types (caps, provider info, GenerationRequest/Record, Conversation)
    client/api.ts, client/useWorkspace.ts, client/legacy.ts
    client/ai.ts                     AI route wrappers + prepareImage (canvas downscale for references)
    client/useAi.ts                  Providers + generation polling; imports finished outputs into the project once
    server/storage.ts                fs persistence, side files, generated-file saving (server-only)
    server/http.ts                   StorageError/ProviderError → JSON response
    server/ai/http.ts                ProviderError, HTTP error explanations, postJsonLong (node:https, long timeout)
    server/ai/llm.ts                 Gemini generateContent + OpenAI-compatible; chat()
    server/ai/image.ts               Cloudflare FLUX.2 klein/dev, FLUX.1 schnell, Gemini image (Interactions API)
    server/ai/comfyui.ts             ComfyUI on your GPU: Z-Image Turbo + Qwen-Image-Edit workflows, /object_info model check, upload/queue/history/view, status check
    server/media.ts                  ffmpeg/ffprobe via spawn (no shell): probe, scene detection, keyframes, 1080p render + concat
    server/storycut.ts               Story Cut jobs (detect/describe/render, one at a time), writeStory, keyframe paths
    server/stock.ts                  Pixabay (preferred) / Pexels stock search/download for Story Cuts stock mode; script → lines + searches (AI or bracket-note fallback)
    server/settings.ts               data/settings.json (ComfyUI address + optional auth header), sync cached read
    server/ai/video.ts               Gemini Omni Flash (Interactions API), fal.ai queue (Kling/Wan)
    server/ai/audio.ts               TTS: Kokoro (local, lazy-loaded, 1 job at a time, idle unload) + Gemini TTS; WAV utils
    server/generations.ts            Job validation (caps, paid approval), background runner, records
    server/assistant.ts              Project context builder, companion prompt, conversations, script-assistant tasks
data/                                Runtime data (git-ignored)
```

## Storage

```
data/projects/<id>/project.json          project document (client-owned, revision-checked PUT)
data/projects/<id>/project.json.bak      previous version
data/projects/<id>/files/<assetId>.<ext> uploaded and generated files
data/projects/<id>/generations.json      generation job records (server-owned)
data/projects/<id>/conversations.json    AI conversations (server-owned)
data/projects/<id>/storycuts.json        Story Cut job records (server-owned)
data/projects/<id>/cache/                keyframes/thumbnails, cached voice lines, downloads and render temp (derived; safe to delete)
data/settings.json                       server settings edited in the UI (ComfyUI address/auth; never sent to the browser)
data/models/                             Kokoro model cache (downloaded on first TTS use)
```

- `project.json` is written by the client through `PUT`, with optimistic concurrency (a `409` triggers a reload banner). Side files are written only by the server under a per-file lock, so they never conflict with client saves.
- `normalizeProject()` validates every load and save and drops dangling references. Keep it in sync with `types.ts`.
- Removing an asset from the document deletes its file on the next save.
- **Generated outputs:** the job runner writes files and stores their `Asset` records in the generation record. The client (`useAi`) then adds them to `project.assets`, links them to `shot.generatedAssetIds`, and records the job ID in `project.importedGenerationIds`, so each job is imported once even if its asset is later deleted.

## Data model highlights (`src/lib/types.ts`)

- Story cuts: `project.storyCuts[]` with `mode` (`stock`: user script → lines with a stock-site `query` and found `stock` options; the chosen clip is downloaded as a `stock`-tagged asset + segment, unused ones are deleted on swap/re-run (`dropUnusedStock`); `story`: AI writes narration per scene; `script`, the default: user script → `cast` + `lines[]` each pointing at a chosen scene with AI `options`; the `auto` job runs detect → describe → cast → match in one go and stores partial results on the job), `sources` (video assets + optional range), `segments` (array order = edit order; start/end in the source, keyframes, description, narration, skip), voice settings, `filmVolume`, `outputAssetIds`. Job results (scenes, descriptions, renders) are imported by `useStoryCuts` once, tracked in `importedGenerationIds`.
- Project: `scripts`, `scenes` (array order = scene order per script), `shots` (array order = shot order per scene), `characters` (+ `variations`), `locations` (+ `angles`), `assets`, `activity`, `importedGenerationIds`.
- Shot: camera fields, `characters: {characterId, variationId}[]`, `locationId`, `locationAngleId`, `assetIds` (references), and `generatedAssetIds` (AI takes).
- Shot and scene numbers are derived (`shotNumber`, `sceneNumber`). Never store them.

## AI architecture

- **Providers** are server-side adapters with honest capability descriptors (`ImageCaps`/`VideoCaps` in `src/lib/ai/types.ts`): max reference images (0 = text-only), image-to-image / image-to-video, aspect ratios, sizes, durations, resolutions, `referenceMaxSide`, and cost per second. `GET /api/providers` exposes `configured`, `billing` (`free-allocation`/`paid`/`self-hosted`; only `paid` needs per-job approval), `costNote`, `requirements`, `setup` and `conditioning`, derived from env (and `data/settings.json` for ComfyUI). The UI is driven entirely by this, so adding a provider requires no UI changes.
- **References:** the browser picks reference images from the shot's continuity bundle (`buildContinuityBundle`, ordered primary identity → wardrobe → location angle → location → shot refs). It downscales them with a canvas (`prepareImage`, ≤511px for Cloudflare FLUX.2) and sends them as base64 JPEG. Adapters label each image in the prompt (FLUX.2: "image N = …", Gemini: a text part before each image).
- **Jobs:** `POST /generations` validates against caps, requires `approvedPaid: true` for paid providers, stores a `running` record and runs in the background (max 3 concurrent per server). The client polls every 3 s while jobs run. Jobs interrupted by a server restart are marked failed, with advice to check the provider dashboard. Paid jobs are never retried automatically.
- **Audio** jobs use the same pipeline (`type: "audio"`, `audioSettings: {voice, speed?, style?}`) and produce WAV assets.
  - Kokoro gotcha: `kokoro-js` 1.2.x `stream(string)` never finishes, because it doesn't close its splitter. Always pass a closed `TextSplitterStream`.
  - fp32 is the default dtype because it was ~2× faster than q8 on the dev CPU (no VNNI).
- **ComfyUI:** API-format graphs built in `comfyui.ts`. Before each job it fetches `/object_info/<Class>` to check model files exist and to fill defaults for required inputs newer ComfyUI versions add (`fillDefaults`). Progress comes from polling `/queue` + `/history`. It never starts/stops pods. Verify node names against the official templates in Comfy-Org/workflow_templates when changing workflows.
- **Story Cuts** need ffmpeg on the machine (`sudo apt install ffmpeg`, or `FFMPEG_PATH`/`FFPROBE_PATH`); the UI shows setup if missing. Jobs run one at a time (RAM). Scene description sends keyframes to the active LLM as images (`LlmMessage.images`: Gemini `inline_data`, OpenAI-compatible `image_url`). Render (`clipsFor`): story mode — each scene lasts max(scene, voice + 0.5 s); script mode — each line's clip follows the voice (min 2 s), continuing into later footage if the voice is longer; 1920×1080 pad, 30 fps, libx264 veryfast CRF 21, AAC; silent sources get a silent track; parts joined with the concat demuxer.
- **Stock clips:** Pixabay when `PIXABAY_API_KEY` is set (`/api/` and `/api/videos/`, key as a query param, plain-text errors, 100 req/60 s, results cached 24 h in `data/cache/pixabay/` as its terms require; video "medium" rendition ≤1920 px, landscape only; fresh link via `?id=` before download). Otherwise Pexels: `PEXELS_API_KEY` (free; 200 requests/hour). Auth header is the raw key; endpoints `/v1/videos/search`, `/v1/search`, `/v1/videos/videos/:id` (fresh signed link before download, since `player.vimeo.com` links can expire). Downloads only from https Pexels/Vimeo hosts, streamed to disk. Picks the widest MP4 ≤1920 px. Without an AI key, lines/queries come from bracket notes (`planWithoutAi`: names/titles stripped). Photos render with a zoompan "Ken Burns" (about 5× slower than real time on the dev CPU).
- **Long calls** (Gemini image/video) use `postJsonLong` (`node:https`, up to 20 min), because undici `fetch` has a 5-minute header timeout. fal.ai uses its queue (submit → poll `status_url` → `response_url`). Gemini Omni uses `delivery: "uri"`, then polls Files API state and downloads.
- **Text:** `chat()` uses `LLM_PROVIDER`, or else the first configured provider (Gemini, then OpenAI-compatible). The companion sends the last 24 messages plus a live project context (`projectContext`, IDs included, ~40k chars max). The client calls `ws.saveNow()` before chat and assist so the server reads current data.
- **Proposals:** the companion appends a ` ```wonderboy {"proposals":[…]} ``` ` block, and the assistant returns JSON. Both go through `normalizeProposal` (IDs validated against the project). `applyProposal` never deletes. A script replacement needs `replace: true`, which the UI sends only after `confirm()`. Scene updates and logline replacement also ask for confirmation.
- **Honesty rules:** never claim consistency is guaranteed. Label text-only models as such. Never auto-trigger paid generation. Never fake success: errors from providers are surfaced (`explainHttpError` maps 400/401/402/404/429/5xx).

## API routes

| Route | Method | Behaviour |
|---|---|---|
| `/api/projects` | GET / POST | List summaries + `firstRun` / create `{ name, logline?, style?, starter? }` |
| `/api/projects/[id]` | GET / PUT / DELETE | Document / `{project, revision}` → `{revision, updatedAt}` or `409` / delete everything |
| `/api/projects/[id]/files` | POST | multipart `files` → `{ assets }` (200 MB max each) |
| `/api/projects/[id]/files/[assetId]` | GET | Stream with Range, nosniff, sandbox CSP |
| `/api/providers` | GET | `ProvidersResponse` |
| `/api/projects/[id]/generations` | GET | `{ generations: (GenerationRecord & {progress})[] }` |
| `/api/projects/[id]/generations` | POST | `GenerationRequest & {label}` → `202 { generation }`, or `400` with a reason |
| `/api/projects/[id]/conversations` | GET / POST | List / create |
| `/api/projects/[id]/conversations/[cid]` | PATCH / DELETE | Rename `{title}` / delete |
| `/api/projects/[id]/conversations/[cid]/messages` | POST | `{message, focus?: {scriptId, sceneId}}` → `{conversation, provider}`. Persists both turns only on success |
| `/api/projects/[id]/assist` | POST | `{task, instructions?, focus?}` → `{summary, proposals, provider}` (tasks are listed in `ASSIST_TASKS`) |

No auth (single local user). Environment variables are documented in `.env.example`.

## Layout and styling

- **App shell:** above 620px, the shell is viewport-height with a pinned sidebar, and only `.main-area` scrolls under a sticky topbar. At 620px and below, the page scrolls normally and the nav becomes a sticky strip. Breakpoints: 1100 / 900 / 620px.
- **Tokens:** colours `--bg --panel --line --text --muted --gold --green`. Type scale `--fs-micro` 11 (the minimum) through `--fs-display`. Use tokens, never ad-hoc px.
- **Common classes:** `.panel`, `.section-head`, `.button.primary|secondary`, `.field` inside `<label>`, `.form-grid(.three)`, `.chip`, `.item-card`, `.modal`, `.proposal`, `.gen-card`, `.status-pill`, `.provider-note`, `.setup-note`, `.error-text`.

## Coding conventions

- TypeScript strict, no `any`. Validate untrusted JSON: `normalizeProject` for projects, `normalizeProposal` for model output, `cleanRef` for uploads to the generation API.
- `src/lib/server/**` uses Node APIs. Import it only from route handlers. `projectModel.ts`, `continuity.ts`, `proposals.ts` and `ai/types.ts` must stay pure.
- All project edits go through `ws.mutate(recipe, activity?)`. Put cascades in `projectModel.ts`.
- New provider: implement the interface in `server/ai/{llm,image,video}.ts` with accurate caps, costs and a `conditioning` description, and add it to `PROVIDERS`. Verify request fields against the provider's current docs.
- Don't render nested component definitions inside a component (they remount on every render). Use render helpers instead.
- Escape apostrophes in JSX text. Use raw `<img>` for local file URLs, with an eslint-disable comment.
- Update `docs/PROGRESS.md` and `docs/PROVIDERS.md` when integrations change.

## Limitations & unfinished work

- **Provider adapters are untested against live accounts.** No keys were configured during development, so each was written against current docs and the first real call is the real test. Cloudflare FLUX.2 form fields come from Cloudflare's changelog examples, because the official schema doesn't list them.
- **No free video generation exists** among the integrated providers. All video is paid. ComfyUI video (Wan 2.2) on the rented GPU isn't built yet.
- **Story Cuts:** the AI sees only 1–2 keyframes per scene, so descriptions can be wrong (they're editable). Detection/render speed on the dev laptop is slow for long films (use a range). Footage rights are the user's responsibility; the UI recommends stock/public-domain footage.
- **ComfyUI providers are untested on a real GPU** (only against a simulated server). Wonderboy can't start/stop the pod or meter its cost yet, so the user must stop it on RunPod. ComfyUI has no auth; the RunPod proxy URL is the only protection.
- **Consistency is improved, not guaranteed.** There's no LoRA or identity training.
- Job execution is in-process. A server restart interrupts running jobs (they're marked failed), and there's no cancel button.
- Chat isn't streamed. The companion only sees the saved project (the client saves first) and the last 24 messages.
- Companion voice chat uses browser APIs (Chrome/Edge are best). There's no realtime speech-to-speech model.
- Kokoro TTS on an old laptop CPU renders about 3× slower than real time, and only English is local. Gemini TTS (Hindi) isn't live-tested yet, and its free-tier limits are unpublished.
- `npm audit` reports high-severity advisories in `postcss` (via Next) and `sharp` (via Next and transformers). These are image-processing paths the app doesn't expose to untrusted input. Review when upgrading Next.
- Local single-user storage: no auth or cloud sync. Back up `data/` yourself. Export is JSON only, and there's no import. Uploads are buffered in memory (200 MB cap), and files never saved to the document can become orphans.
- Tabs aren't URL routes. No timeline editor and no automated tests.
