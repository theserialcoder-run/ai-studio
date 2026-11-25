# Wonderboy AI Studio — Progress

## Product direction
A private AI filmmaking workspace combining an AI creative companion, scriptwriting, shot planning, character/location continuity, image generation and video generation.

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
- [x] **Continuity management:** shots link characters (+ wardrobe variation), location (+ camera angle) and extra reference files; persistent reference records; structured `ContinuityBundle` (src/lib/continuity.ts) sent to the generation routes, with reference image URLs
- [x] Image/Video Studio: pick a shot or manual references, see attached references, prepare continuity prompt, copy prompt / continuity JSON
- [x] AI companion API route (Gemini optional), now with scene/character/location context and auto-scroll
- [x] Browser speech input/output prototype
- [x] Image/video provider route placeholders that do not start paid GPU jobs
- [x] Project JSON export

## Not yet implemented
- [ ] Connect a real image-generation provider (reference-conditioned)
- [ ] Connect a real video-generation provider
- [ ] Guaranteed visual consistency (requires reference-conditioned generation; not claimed today)
- [ ] Project import (JSON + files) and full backup/restore
- [ ] Orphaned upload cleanup
- [ ] Multi-turn / persisted chat
- [ ] Voice conversation / realtime audio
- [ ] Timeline editor and export pipeline
- [ ] Authentication, multi-user, cloud storage and deployment
- [ ] Automated tests

## Important limitations
This is a functional single-user local workspace, not a finished production system. Data is stored on the machine running the server (`data/`, git-ignored) and should be backed up manually. Image and video generation routes intentionally do not call an external provider. Saving the same project from two tabs is detected (conflict banner) but not merged. Do not put API keys in client-side code.

## Development rule
Update this file after every meaningful change. Keep provider integrations behind server-side adapters. Never trigger paid GPU inference without an explicit user action and clear cost indication.
