# Wonderboy AI Studio — Progress

## Product direction
A private AI filmmaking workspace combining an AI creative companion, scriptwriting, shot planning, character/location continuity, image generation and video generation.

## Current starter status
- [x] Next.js + TypeScript application scaffold
- [x] Dark cinematic responsive interface
- [x] Project overview and local project persistence
- [x] Script editor
- [x] Shot planner
- [x] Character and location reference library
- [x] Upload references or describe/generate them through a future provider connection
- [x] Continuity prompt preparation from saved project style and references
- [x] AI companion API route (Gemini optional)
- [x] Browser speech input/output prototype
- [x] Image/video provider route placeholders that do not start paid GPU jobs
- [x] Project JSON export
- [x] App-shell layout: pinned sidebar, sticky topbar, only main content scrolls; mobile sticky nav strip
- [x] Consistent typography scale (CSS tokens in globals.css)
- [x] ESLint flat config (`npm run lint` works) and CLAUDE.md project guide
- [ ] Persistent database and media storage
- [ ] Production-grade character/location reference conditioning
- [ ] Connect a real image-generation provider
- [ ] Connect a real video-generation provider
- [ ] Voice conversation / realtime audio
- [ ] Timeline editor and export pipeline
- [ ] Authentication and deployment

## Important limitations
This is a substantial functional starter, not a finished Higgsfield replacement. Image and video generation routes intentionally do not call an external provider yet. The reference library stores uploaded images in browser local storage; this is suitable for prototyping only and can hit browser storage limits. Do not put API keys in client-side code.

## Development rule
Update this file after every meaningful change. Keep provider integrations behind server-side adapters. Never trigger paid GPU inference without an explicit user action and clear cost indication.
