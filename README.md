# Wonderboy AI Studio

A personal AI filmmaking workspace starter. It combines project management, scriptwriting, shot planning, character/location references, an AI companion interface, and provider-independent image/video generation entry points.

## Requirements
- Node.js 20.9 or newer
- npm
- A modern browser

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

The core workspace works without API keys. To enable AI features, follow the quick start in `docs/PROVIDERS.md` (Gemini key for text, Cloudflare token for free image generation), then restart the dev server.

## Current capabilities
- Multiple projects: create, switch, rename, delete; dashboard with progress and recent activity
- Script studio: multiple scripts, scenes with dialogue, characters and location; scenes from sluglines
- Scene & shot planner: camera angle, movement, framing, lighting, mood, duration; reorder, duplicate, delete
- Character library with identity references and wardrobe variations
- Location library with reference images and camera angles
- Asset library (images, video, audio, documents) linked to characters, locations and shots
- Continuity links per shot and a structured continuity bundle for future generation providers
- AI Companion (multi-turn, per-project history, voice in/out) and AI Script Assistant with review-before-apply proposals
- Image generation (Cloudflare FLUX.2 free allocation with reference images; Gemini paid) and video generation (Gemini Omni / fal.ai, paid)
- Voice Studio: free unlimited English text-to-speech on your own computer (Kokoro), Hindi and other languages via Gemini TTS free tier
- Project JSON export

Projects and uploaded files are saved on disk in `data/` (git-ignored). Back this folder up.

## Not yet implemented
Guaranteed visual consistency, free video generation, project import, real-time voice conversation, cloud storage, multi-user auth and a timeline editor. See `docs/PROGRESS.md`.

## Important
No Modal or GPU server is needed. Generation uses hosted APIs with your own keys. Paid providers always show an estimate and ask for confirmation. See `docs/PROVIDERS.md`.
