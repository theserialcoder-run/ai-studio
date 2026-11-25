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

The core workspace works without API keys. To enable Gemini chat, add `GEMINI_API_KEY` to `.env.local`, then restart the dev server.

## Current capabilities
- Multiple projects: create, switch, rename, delete; dashboard with progress and recent activity
- Script studio: multiple scripts, scenes with dialogue, characters and location; scenes from sluglines
- Scene & shot planner: camera angle, movement, framing, lighting, mood, duration; reorder, duplicate, delete
- Character library with identity references and wardrobe variations
- Location library with reference images and camera angles
- Asset library (images, video, audio, documents) linked to characters, locations and shots
- Continuity links per shot and a structured continuity bundle for future generation providers
- AI companion route (Gemini optional) and browser speech input/output prototype
- Project JSON export
- Safe image/video provider placeholders

Projects and uploaded files are saved on disk in `data/` (git-ignored). Back this folder up.

## Not yet implemented
Real image/video generation (and therefore guaranteed visual consistency), project import, real-time voice conversation, cloud storage, multi-user auth and a timeline editor. See `docs/PROGRESS.md`.

## Important
This starter does not require Modal and does not launch any GPU. Image/video generation buttons report that a provider adapter must be configured. This is intentional: choose a free/low-cost provider and verify its current terms before enabling generation.
