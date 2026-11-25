# CLAUDE.md — Wonderboy AI Studio

Guidance for Claude Code (and humans) working in this repository. It describes the code **as it exists today**. When something here disagrees with the code, the code wins: fix this file.

## What this is

Wonderboy AI Studio is a private, single-user **AI filmmaking workspace**. It runs as a local Next.js app and is used in the browser. It manages multiple film projects, and each project holds its own:

- scripts (screenplay text) organised into **scenes**,
- **shots** per scene, with camera, lighting, mood and duration details,
- a **character library** (identity + wardrobe/appearance variations + reference images),
- a **location library** (fixed details + camera angles + reference images),
- an **asset library** of uploaded files (images, video, audio, documents),
- continuity links from each shot to its characters, location and reference files,
- an activity log and progress dashboard.

There is also an AI companion chat (Gemini, optional) and Image/Video Studio screens that build structured **continuity bundles** for future generation providers. **No image or video generation is implemented.** The generate routes are placeholders. See [Limitations](#limitations--unfinished-work).

Other docs:
- `docs/PROGRESS.md` is the source of truth for feature status. Update it after meaningful changes.
- `docs/ARCHITECTURE.md` covers the continuity design and provider-adapter principles.
- `docs/PROVIDERS.md` covers how to choose and connect Gemini and image/video providers.

## Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5, `strict: true`, path alias `@/*` → `src/*` |
| Styling | One global stylesheet, `src/app/globals.css`: plain CSS with custom-property tokens. No Tailwind, no CSS modules, no component library |
| Fonts | Google Fonts via CSS `@import`: DM Sans, DM Mono, Playfair Display |
| Persistence | JSON documents + uploaded files on the local file system, via Node `fs` in API routes (no database) |
| AI | Gemini `generateContent` REST API via `fetch` in `/api/chat` (no SDK) |
| State | React state + one custom hook (`useWorkspace`) + a React context (`StudioContext`) |
| Lint | ESLint 9 flat config (`eslint.config.mjs`) extending `next/core-web-vitals` + `next/typescript` |
| Runtime deps | Only `next`, `react` and `react-dom`. Keep it that way unless there is a strong reason |

## Commands

Requires Node.js ≥ 20.9 and npm.

```bash
npm install
cp .env.example .env.local   # optional; app works without keys
npm run dev                  # http://localhost:3000
npm run lint                 # ESLint
npx tsc --noEmit             # type check (also runs during build)
npm run build                # production build (also lints + type-checks)
npm start                    # serve the production build
```

- **Tests:** there is no test suite and no `test` script. Verify with `npx tsc --noEmit`, `npm run lint` and `npm run build`. For storage/API changes, a short `curl` smoke test against `npm start` with `WONDERBOY_DATA_DIR` pointing at a temporary folder is enough.
- **The dev machine has limited RAM (8 GB).** Don't run headless browsers, screenshot tooling or long-lived background servers unless asked.
- `next dev` and `next start` both write `.next/`. Never run them at the same time.
- `.env.local` changes need a server restart.

## Folder structure

```
src/
  app/
    layout.tsx                         Root layout, imports globals.css
    page.tsx                           App shell: sidebar (project switcher + nav), topbar (save state), banner, view routing
    globals.css                        All styles (tokens → base → shell → components → views → responsive)
    api/
      chat/route.ts                    POST Gemini companion
      generate/image/route.ts          POST placeholder; accepts a continuity bundle, never calls a provider
      generate/video/route.ts          POST placeholder; same
      projects/route.ts                GET list · POST create
      projects/[id]/route.ts           GET document · PUT replace (revision-checked) · DELETE project + files
      projects/[id]/files/route.ts     POST multipart upload → asset records
      projects/[id]/files/[assetId]/route.ts   GET stream file (Range support)
  components/
    studio.tsx                         StudioContext/useStudio, TABS, shared UI (fields, Modal, AssetPreview,
                                       UploadButton, AssetPicker, ReferenceImages, RowActions)
    ProjectsView.tsx                   Create / open / rename / delete projects
    DashboardView.tsx                  Overview: stats, progress bars, recent activity, workflow
    CompanionView.tsx                  AI chat (+ browser speech in/out)
    ScriptStudio.tsx                   Scripts list, screenplay editor, scenes (edit/reorder/delete, slugline import)
    ShotPlanner.tsx                    Shots per scene (full spec, reorder/duplicate/delete, continuity links)
    ContinuityPicker.tsx               Characters (+variation) and location (+angle) selector
    CharacterLibrary.tsx               Characters, identity references, wardrobe variations
    LocationLibrary.tsx                Locations, master references, camera angles
    AssetLibrary.tsx                   Upload, filter, tag, link/unlink, download, delete files
    GenerationStudio.tsx               Image/Video Studio: builds continuity bundle + prompt, calls placeholder routes
    SettingsView.tsx                   Project settings, style bible, provider info, export, delete
  lib/
    types.ts                           Domain types (Project, Script, Scene, Shot, Character, Location, Asset, …)
    projectModel.ts                    PURE helpers shared by client + server: factories, normalizeProject (validation),
                                       selectors (shot/scene numbering), mutations (cascading deletes), activity log
    continuity.ts                      buildContinuityBundle / continuityPrompt (generation request contract)
    client/api.ts                      fetch wrappers for /api/projects*
    client/useWorkspace.ts             Workspace hook: project list, open project, mutate + debounced save, uploads
    client/legacy.ts                   One-time import of the old localStorage project format
    server/storage.ts                  File-system persistence (server-only; imports node:fs)
    server/http.ts                     StorageError → JSON response
    server/generation.ts               Summarizes received continuity bundles for placeholder routes
  types/speech.d.ts                    Web Speech API typings
data/                                  Runtime data (git-ignored), see Storage
docs/                                  PROGRESS.md, ARCHITECTURE.md, PROVIDERS.md
```

## Storage

Server-side, under `data/` (override with `WONDERBOY_DATA_DIR`):

```
data/projects/<projectId>/project.json        the whole project document
data/projects/<projectId>/project.json.bak    previous saved version (written on every save)
data/projects/<projectId>/files/<assetId>.<ext>   uploaded files
```

- Writes are atomic (temp file + rename) and serialised per project with an in-process lock.
- **Optimistic concurrency:** each document has a `revision`. `PUT` must send the revision it last saw, and a mismatch returns `409`. The UI then shows a conflict banner with a "Reload project" button.
- Every load and save passes through `normalizeProject()`, which fills defaults, coerces types, and drops dangling references (unknown character, location, scene or asset IDs). Keep it in sync when the model changes, because it doubles as the schema migration.
- **File lifecycle:** upload stores the file and returns an `Asset` record, and the client adds that record to the document. When a saved document no longer contains an asset, the server deletes its file. Deleting a project deletes its folder.
- Files are looked up by asset-ID prefix on disk, so they're viewable before the document save lands.
- IDs in URLs must match `^[A-Za-z0-9_-]{1,64}$`, which prevents path traversal.
- First run: when `data/projects` doesn't exist yet, the client imports the old `localStorage["wonderboy-studio-project-v1"]` project if present (base64 images become real uploaded files), or else creates the starter project "The Disturbance". The old browser data is left untouched.
- The last opened project ID is remembered in `localStorage["wonderboy-active-project"]`. That's a convenience only.

## Data model (`src/lib/types.ts`)

One `Project` document contains everything:

- `scripts: Script[]`: `{ title, content }`.
- `scenes: Scene[]`: `{ scriptId, heading (slugline), title, description, dialogue, characterIds[], locationId }`. **Array order is scene order** within a script.
- `shots: Shot[]`: `{ sceneId|null, title, description, cameraAngle, cameraMovement, framing, lighting, mood, durationSec, status, notes, characters: {characterId, variationId}[], locationId, locationAngleId, assetIds[] }`. **Array order is shot order** within a scene. `sceneId: null` means unassigned.
- `characters: Character[]`: identity (`description, appearance, clothing, personality, notes`), `referenceAssetIds`, `primaryAssetId`, and `variations: {name, description, assetIds}[]` (wardrobe/appearance changes that leave identity intact).
- `locations: Location[]`: `description, architecture, environment, layout, lighting, visualDetails`, `referenceAssetIds`, `primaryAssetId`, and `angles: {name, description, assetIds}[]`.
- `assets: Asset[]`: `{ name, kind, mimeType, size, fileName, tags, notes }`. Other records reference assets **by ID only**. "Used by" is computed by scanning, never stored.
- `activity: ActivityEntry[]`: newest first, capped at 60. Repeated identical messages within 10 minutes are collapsed.

Shot numbers (`"3.2"`, `"U.1"` for unassigned) and scene numbers are **derived** from array order (`shotNumber`, `sceneNumber`). Don't store them.

## Client state and data flow

- `useWorkspace()` (`src/lib/client/useWorkspace.ts`) owns the project list, the open project, `saveState` (`idle | saving | saved | error | conflict`), and these actions: `openProject`, `createProject`, `renameProject`, `deleteProject`, `reloadProject`, `uploadFiles`, `saveNow`.
- **All edits go through `ws.mutate(recipe, activityMessage?)`**. The recipe mutates a `structuredClone` of the project, and a debounced `PUT` (700 ms) follows. Saves are serialised, and switching projects flushes pending saves first. `beforeunload` attempts a keepalive save and warns if anything is unsaved.
- Put cascading changes in `projectModel.ts` (`removeCharacter`, `removeLocation`, `removeScene`, `removeAsset`, `moveWithinGroup`, …) so views stay thin.
- Views read `{ ws, project, notify, go, focusShotId, focusSceneId }` from `useStudio()`. `ProjectsView` is the exception: it takes `ws` as a prop because it must work with no project open.
- Navigation is in-memory tab state in `page.tsx` (`TABS` in `studio.tsx`), not URL routes. Per-project views are keyed by project ID so local UI state resets on switch.
- Chat history lives in `page.tsx` (it survives tab switches, not reloads or project switches).

## Continuity (`src/lib/continuity.ts`)

`buildContinuityBundle(project, { shotId } | { characters, locationId, locationAngleId })` returns a `ContinuityBundle` containing:
- `style`: the project's style bible.
- `shot`: the full shot spec and derived number.
- `characters[]`: identity fields, the selected wardrobe variation (or the default clothing), and `referenceImages`. Identity images come first, primary first, then the variation's images.
- `location`: fields, the selected angle, and `referenceImages` (angle images first).
- `additionalReferences`: the shot's own image references.

Each `ReferenceImage` is `{ assetId, name, mimeType, url, role, primary }`, where `url` is the same-origin `/api/projects/<id>/files/<assetId>`. A future provider adapter must fetch or upload these server-side. `continuityPrompt()` produces readable prompt text from a bundle. Image/Video Studio `POST`s `{ prompt, userPrompt, continuity }` to the generate routes. **Never claim visual consistency is guaranteed.** The UI deliberately says it isn't, until reference-conditioned generation exists.

## API routes

| Route | Method | Behaviour |
|---|---|---|
| `/api/projects` | GET | `{ projects: ProjectSummary[], firstRun }` (sorted by `updatedAt`) |
| `/api/projects` | POST | `{ name?, logline?, style?, starter? }` → `201 { project }` |
| `/api/projects/[id]` | GET | `{ project }`, or `404` |
| `/api/projects/[id]` | PUT | `{ project, revision }` → `{ revision, updatedAt }`, or `409` on conflict, or `400` |
| `/api/projects/[id]` | DELETE | Removes the document and all files |
| `/api/projects/[id]/files` | POST | multipart `files` (multiple) → `201 { assets }`. Max 200 MB per file (buffered in memory) |
| `/api/projects/[id]/files/[assetId]` | GET | Streams the file with `Range` support, `nosniff`, a sandbox CSP, and `inline` only for raster images, video, audio and PDF |
| `/api/chat` | POST | `{ message, project: {name, logline, style, script, scenes, characters, locations} }` → Gemini `gemini-2.0-flash`, or a "not connected" reply |
| `/api/generate/image` | POST | `{ prompt, userPrompt, continuity }` → `{ status: "not_configured" \| "adapter_required", message }`. **Never calls a provider** |
| `/api/generate/video` | POST | Same as image |

No auth: the app assumes a single local user. Environment variables (all optional) are `GEMINI_API_KEY`, `IMAGE_API_URL`, `IMAGE_API_KEY`, `VIDEO_API_URL`, `VIDEO_API_KEY`, `IMAGE_PROVIDER`/`VIDEO_PROVIDER` (unused so far), and `WONDERBOY_DATA_DIR`. Never use secrets in client code and never prefix them `NEXT_PUBLIC_`.

## Layout, styling and typography

- **App shell:** above 620px, `.shell` is viewport-height, the sidebar is pinned, only `.main-area` scrolls, and `.topbar` is sticky inside it. At 620px and below, the page scrolls normally and the sidebar becomes a sticky horizontal nav strip. Breakpoints are 1100 / 900 / 620px, using the layout tokens `--sidebar-w`, `--topbar-h` and `--gutter`.
- **Colour tokens:** `--bg --panel --panel2 --line --text --muted --gold --green`. Dark theme only.
- **Type scale tokens** (use these, never ad-hoc px): `--fs-micro` 11 (mono caps labels, meta; the minimum), `--fs-xs` 12, `--fs-sm` 13 (buttons), `--fs-input` 14 (16 on mobile), `--fs-base` 15 (body, chat), `--fs-md` 16, `--fs-lg` 18 (panel headings), `--fs-xl` 22 (page title), `--fs-2xl` 28 (section headings, stats), and `--fs-display` (hero only).
- **Common classes:** `.panel`, `.panel-head`, `.section-head`, `.button.primary|secondary`, `.text-button`, `.tiny-button`, `.field` (inside a `<label>`), `.form-grid(.three)`, `.chip(.on|.static)`, `.item-card` (expandable rows), `.toolbar`, `.modal`, `.thumb-grid`, `.empty-state`, `.danger-text`.

## Coding conventions

- TypeScript strict, no `any`. Validate untrusted JSON through `normalizeProject` rather than trusting shapes.
- `src/lib/server/*` imports `node:fs`. Import it only from route handlers, never from components.
- `src/lib/projectModel.ts` and `src/lib/continuity.ts` must stay pure (no DOM, no Node APIs), because both sides use them.
- New record types or fields: add them to `types.ts`, the factory and `normalizeProject`, and give deletions a cascading `remove*` helper.
- Activity messages should describe what changed in user terms (`Edited shot 2.1 “Kitchen wide”`).
- Provider calls happen only server-side, behind adapters. **Never trigger paid GPU inference automatically.**
- Don't add dependencies casually.
- Escape apostrophes in JSX text (`&apos;`). Raw `<img>` is used deliberately for local file URLs, with `eslint-disable-next-line @next/next/no-img-element`.
- Update `docs/PROGRESS.md` when a feature's status changes.

## Limitations & unfinished work

- **No image/video generation.** The routes are placeholders. The continuity bundle is ready for adapters, but **visual consistency is not guaranteed** until reference-conditioned generation exists.
- **Local single-user storage.** There's no database, auth, multi-user support or cloud sync. Data lives in `data/` on the machine running the server, so back it up yourself.
- **Uploads** are buffered fully in memory (200 MB cap). A file uploaded but never saved into the document (e.g. the tab was closed within the save delay) stays on disk as an orphan, and there's no orphan cleanup.
- **Export** is JSON only (records + file metadata, not the files). There's **no import** apart from the one-time legacy `localStorage` migration.
- **Concurrency** is limited to conflict detection (`409` + reload). There's no merging, so the reload discards the local tab's unsaved edits.
- Shots can only move between scenes via the editor's scene select. There's no drag-and-drop.
- **Chat:** single-turn (no history sent), not persisted, no streaming. The model name is hard-coded, and the API key is sent as a URL query parameter.
- Settings provider status is static text. `*_PROVIDER` env vars are unused.
- Tabs aren't URL routes (no deep links or back-button navigation).
- No automated tests. No timeline editor, deployment config or realtime voice.
