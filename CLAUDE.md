# CLAUDE.md — Wonderboy AI Studio

Guidance for Claude Code (and humans) working in this repository. It describes the code **as it exists today**. When something here disagrees with the code, the code wins: fix this file.

## What this is

Wonderboy AI Studio is a private, single-user **AI filmmaking workspace** that runs in the browser. You develop a film from idea to shots in one place:

- talk an idea through with an AI companion (Gemini, optional),
- write the screenplay,
- break it into a shot list,
- keep a continuity library of character and location references,
- prepare continuity-aware prompts for image/video generation.

It is a **functional prototype ("starter")**. Image and video generation are deliberately **not** wired to any provider yet. See [Limitations](#limitations--unfinished-work).

Other docs:
- `docs/PROGRESS.md` is the source of truth for feature status. Update it after meaningful changes.
- `docs/ARCHITECTURE.md` covers the continuity design and provider-adapter principles. Parts of it are target design, not current code.
- `docs/PROVIDERS.md` covers how to choose and connect Gemini and image/video providers.

## Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5, `strict: true`, path alias `@/*` → `src/*` |
| Styling | One global stylesheet, `src/app/globals.css`: plain CSS with custom-property tokens. No Tailwind, no CSS modules, no component library |
| Fonts | Google Fonts via CSS `@import`: DM Sans (UI), DM Mono (labels/meta), Playfair Display (headings) |
| AI | Google Gemini `generateContent` REST API, called with `fetch` from a server route (no SDK) |
| Persistence | Browser `localStorage` only |
| Lint | ESLint 9 flat config (`eslint.config.mjs`) extending `next/core-web-vitals` + `next/typescript` |
| Runtime deps | Only `next`, `react` and `react-dom`. Keep it that way unless there is a strong reason |

There is **no** database, auth, state library, test framework or UI kit.

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

- **Tests:** there is no test suite and no `test` script. Verify changes with lint, `tsc`, `build`, and by running the app.
- `next dev` and `next start` both use `.next/`. Don't run them at the same time, or the production server will serve chunks the dev server has overwritten.
- `.env.local` changes need a dev-server restart.

## Folder structure

```
src/
  app/
    layout.tsx                 Root layout: <html>/<body>, metadata, imports globals.css
    page.tsx                   THE ENTIRE UI: a single "use client" component (Home) + ReferenceGroup
    globals.css                All styles: tokens, app shell, components, per-view styles, breakpoints
    api/
      chat/route.ts            POST: Gemini companion (or a friendly "not connected" reply)
      generate/image/route.ts  POST: image provider placeholder (never calls a provider)
      generate/video/route.ts  POST: video provider placeholder (never calls a provider)
  types/
    speech.d.ts                Minimal Web Speech API typings (SpeechRecognition)
docs/                          PROGRESS.md, ARCHITECTURE.md, PROVIDERS.md
.env.example                   Env var template (copy to .env.local; never commit .env.local)
eslint.config.mjs              ESLint flat config
```

There is no `components/`, `lib/` or `hooks/` directory yet. Everything UI-related lives in `src/app/page.tsx`.

## Application architecture

### UI: one client component, tab-based

`src/app/page.tsx` renders the whole app. Navigation is **in-memory tab state** (`const [tab, setTab] = useState("Overview")`), not routes. There is one URL (`/`), and tabs are not deep-linkable and don't survive reload.

Tabs (the `nav` array): **Overview, AI Companion, Script, Shots, References, Image Studio, Video Studio, Settings**. Each is a conditional block `{tab==="…" && <div className="content">…</div>}`. Image Studio and Video Studio share one block that branches on `tab`.

The JSX is written densely, often one long line per tab. Keep edits surgical and consistent with the surrounding style unless you are deliberately refactoring.

### App shell / layout

```
<main.shell>
  <aside.sidebar>    brand, project pill, nav buttons, status footer
  <section.main-area>
    <header.topbar>  eyebrow + <h1>{tab}</h1>, "Saved locally", Export button
    <div.content>    active tab
    <footer.footer>  static label + `notice` status message
```

Scrolling model (in `globals.css`):
- **>620px (desktop/tablet):** `.shell` is exactly viewport height (`100dvh`) with `overflow:hidden`. `.sidebar` is a pinned full-height column that scrolls on its own if it overflows. **Only `.main-area` scrolls**, and `.topbar` is `position:sticky; top:0` inside it. The footer sits at the bottom via `margin-top:auto`.
- **≤620px (mobile):** normal document scrolling. The sidebar collapses into a **sticky horizontal nav strip** (brand mark + scrollable tabs). The topbar scrolls away, so there aren't two stacked sticky bars.
- Breakpoints: `1100px` (narrower sidebar/gutters), `900px` (multi-column grids stack to one column), `620px` (mobile).
- Layout tokens: `--sidebar-w`, `--topbar-h`, `--gutter` (overridden per breakpoint).

### State and data flow

All state is React `useState` inside `Home`. There's no context, reducer or external store.

```ts
type RefAsset = { id; name; kind: "character" | "location"; description; image?: string /* data URL */; createdAt };
type Shot     = { id; title; scene; description; characterIds: string[]; locationId: string; status: string };
type Project  = { name; logline; style; script; assets: RefAsset[]; shots: Shot[] };
```

- `project` is the only persisted state. It is saved to `localStorage["wonderboy-studio-project-v1"]` on every change and loaded once on mount (the default is the `starter` project "The Disturbance"). Mutations go through `update(key, value)`.
- Uploaded reference images are read with `FileReader` and stored **inline as base64 data URLs** in the project JSON.
- Everything else is ephemeral: chat history, form inputs, `prompt` and `generatedPrompt`, `notice` (footer status text), `busy` (shared by chat and generation).
- **Export:** `exportProject()` downloads the project as `<slug>-project.json`. There is **no import**.
- **Reset** (Settings): removes the storage key and restores `starter`.

### Feature map

| Tab | What it does | Status |
|---|---|---|
| Overview | Hero, project name/logline, counts (characters/locations/shots/script), workflow shortcuts | Working |
| AI Companion | Chat UI → `POST /api/chat` with `{message, project:{name,logline,style,script}}`. Prompt chips prefill input. 🎙 uses Web Speech recognition (en-US) to fill the input; "Read aloud" uses `speechSynthesis` | Working. Gemini optional. Single-turn only (no history sent), not persisted, no auto-scroll |
| Script | Edit project title, logline, screenplay (monospace textarea), word count, autosave | Working |
| Shots | Add (title + description) / remove shots; "Create image" copies the shot into the Image Studio prompt | Working. Scene label is `Scene NN` from list length. `characterIds`, `locationId` and `status` are never editable in the UI |
| References | Add character/location with name, canonical description, optional image upload; grid per kind; remove | Working (localStorage-backed) |
| Image / Video Studio | Prompt editor; "Prepare continuity prompt" builds `style + CONTINUITY REFERENCES + SHOT PROMPT` locally; "Generate" posts to the placeholder route and shows its message in the footer; copy prepared prompt | Prompt prep works. **Generation is a placeholder** |
| Settings | Edit project name + style bible; provider list; export backup; reset local project | Working. Provider pills are **hard-coded text**, not real env detection |

## API routes

All are `POST`, return JSON, and have no auth or input validation beyond basic type checks.

| Route | Request | Behaviour |
|---|---|---|
| `/api/chat` | `{ message: string, project: {...} }` | No `GEMINI_API_KEY` → `200 { reply: "<not connected explanation>" }`. Otherwise it calls `gemini-2.0-flash:generateContent` with a system instruction that embeds the project JSON, then returns `{ reply }`, or `{ error }` with the upstream status / `502` on network failure. |
| `/api/generate/image` | `{ prompt, projectStyle, references[] }` | Missing `IMAGE_API_URL`/`IMAGE_API_KEY` → `{ status: "not_configured", message }`. Present → `{ status: "adapter_required", message, receivedPrompt }`. **Never calls a provider.** |
| `/api/generate/video` | same | Same pattern with `VIDEO_API_URL`/`VIDEO_API_KEY`. **Never calls a provider.** |

The intended normalized generation response is `{ status, message, jobId?, outputUrl? }` (see `docs/PROVIDERS.md`).

### Environment variables (`.env.example`)

`GEMINI_API_KEY`, `IMAGE_PROVIDER`, `IMAGE_API_URL`, `IMAGE_API_KEY`, `VIDEO_PROVIDER`, `VIDEO_API_URL`, `VIDEO_API_KEY`. All are optional. `*_PROVIDER` is not read anywhere yet. Never read secrets in client code (`page.tsx`) and never prefix them `NEXT_PUBLIC_`.

## Styling and typography conventions

- **Edit `src/app/globals.css`, organised by section:** tokens → base → app shell → shared components → per-view → responsive. Class names are plain and global (`.panel`, `.button.primary`, `.field`, `.eyebrow`, …). Reuse existing classes before adding new ones.
- **Colour tokens:** `--bg --panel --panel2 --line --text --muted --gold --green`. The theme is dark-only with gold accents, so keep it that way.
- **Font tokens:** `--font-sans` (body/UI), `--font-mono` (uppercase micro labels, meta, pills, footer), `--font-display` (Playfair; headings, numbers; weight 500).
- **Type scale (use tokens, not ad-hoc px):**

  | Token | px | Use |
  |---|---|---|
  | `--fs-micro` | 11 | Mono uppercase labels, eyebrows, pills, meta. **Nothing smaller than 11px** except decorative art |
  | `--fs-xs` | 12 | Helper text, captions, tiny buttons |
  | `--fs-sm` | 13 | Buttons, secondary text |
  | `--fs-input` | 14 | Form fields (16px on mobile to stop iOS zoom) |
  | `--fs-base` | 15 | Body copy, chat messages |
  | `--fs-md` | 16 | Lead paragraphs |
  | `--fs-lg` | 18 | Panel / card headings |
  | `--fs-xl` | 22 | Topbar page title, feature headings |
  | `--fs-2xl` | 28 | Section headings, stat numbers |
  | `--fs-display` | clamp 34–46 | Overview hero only |

- Form fields: `<label>` (mono micro caps) wrapping an input/textarea/select with `className="field"`.
- Test at desktop, ~820px and ~390px widths. Nothing should scroll horizontally.

## Coding conventions and guidelines

- TypeScript strict. Don't use `any`; type API payloads inline as the existing routes do.
- **Provider calls only happen server-side**, in `src/app/api/**`. UI components must never call vendor APIs or see keys.
- Put new provider integrations behind an adapter with a normalized contract (see `docs/ARCHITECTURE.md` and `docs/PROVIDERS.md`). **Never trigger paid GPU inference automatically.** It needs an explicit user click and visible cost/limit info.
- Don't add dependencies casually. The app intentionally runs on `next`/`react` only.
- Keep `localStorage` key versioning (`…-v1`) in mind. If you change the `Project` shape, migrate old data or bump the key.
- Escape apostrophes in JSX text (`&apos;`), because ESLint's `react/no-unescaped-entities` is on. `<img>` is used deliberately for data-URL previews, so the `no-img-element` warning is expected.
- User-facing status goes through `setNotice(...)` (shown in the footer).
- Update `docs/PROGRESS.md` when a feature's status changes.

## Limitations & unfinished work

- **No real image/video generation.** The routes are safe placeholders.
- **Storage is browser-only.** Data is per-browser and per-origin, and base64 images can hit the ~5–10 MB `localStorage` quota. The save effect calls `localStorage.setItem` with no `try/catch`, so a quota-exceeded write is an unhandled error inside a React effect. That likely breaks the page, and the user gets no friendly message. There's no import, cloud sync or database.
- **Chat:** single-turn (history isn't sent to Gemini), not persisted, no streaming, no auto-scroll. The Gemini model name (`gemini-2.0-flash`) is hard-coded, and the API key is sent as a URL query parameter.
- **Shots** can't be edited or reordered. Character/location linking fields exist in the type but have no UI.
- **Settings provider status** is static text, not derived from env vars.
- **Voice** is a browser prototype (recognition fills the input once; no realtime conversation).
- No auth, multi-user, timeline editor, deployment config or automated tests.
- Tabs are client state, not routes (no deep links, and the browser back button doesn't change tabs).
