# Architecture

See CLAUDE.md for the full, current description.

- `src/app/page.tsx`: app shell and view routing; views live in `src/components/`.
- `src/lib/types.ts`, `src/lib/projectModel.ts`: domain model and pure helpers (shared by client and server).
- `src/lib/server/storage.ts` + `src/app/api/projects/**`: file-system persistence (`data/projects/<id>/project.json` + `files/`).
- `src/lib/client/useWorkspace.ts`: client state, debounced revision-checked saves, uploads.
- `src/lib/continuity.ts`: builds the continuity bundle sent to generation routes.
- `src/lib/server/ai/*`: provider adapters (text, image, video); `src/lib/server/generations.ts`: job runner; `src/lib/server/assistant.ts`: companion + script assistant.
- `src/lib/proposals.ts`: AI suggestions as reviewable, validated change sets.
- `.env.local`: secrets; never commit it. `data/`: user data; never commit it.

## Current continuity implementation
Characters store identity fields, identity reference images (one primary) and wardrobe/appearance variations with their own images. Locations store fixed details, master references and named camera angles with their own images. Shots link characters (+ variation), a location (+ angle) and extra reference files. `buildContinuityBundle()` turns a shot into an ordered set of references; the Image/Video Studio sends the selected images to reference-conditioned models (Cloudflare FLUX.2, Gemini Nano Banana, Gemini Omni). This improves consistency but does not guarantee it.

## Continuity design
Each project owns a canonical reference library. A character reference should eventually include:
- stable ID and canonical description
- face / front / side / full-body reference images
- wardrobe variants kept separate from identity
- optional expression and pose references
- negative constraints / details that must not change

A location reference should eventually include:
- stable ID and canonical environment description
- master establishing view and alternate camera angles
- fixed architecture, geography, furniture and prop positions
- lighting / time-of-day variants stored separately

Every generation request should identify the selected character and location IDs, attach their reference images where the provider supports it, and record the exact model, prompt, seed, settings and output. Prompt repetition alone is not enough for reliable consistency. Use reference-image conditioning, image-to-image, IP-Adapter / similar methods, or trained LoRAs when legally and technically suitable.

## Provider independence
Define an adapter per provider with a normalized input/output contract. Do not let UI components call vendor APIs directly. API keys stay on the server. Provider adapters must expose model capabilities and estimated cost before enabling paid generation.
