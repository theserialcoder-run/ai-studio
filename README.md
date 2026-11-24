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
- Project details and style bible
- Script editor with local autosave
- Shot planner
- Character and location library (upload or describe)
- Continuity prompt preparation
- AI companion route (Gemini optional)
- Browser speech input/output prototype
- Project JSON export
- Safe image/video provider placeholders

## Not yet implemented
Real image/video generation, robust multi-image continuity conditioning, real-time voice conversation, cloud database/storage, multi-user auth and a timeline editor. See `docs/PROGRESS.md`.

## Important
This starter does not require Modal and does not launch any GPU. Image/video generation buttons report that a provider adapter must be configured. This is intentional: choose a free/low-cost provider and verify its current terms before enabling generation.
