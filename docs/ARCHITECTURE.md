# Architecture

- `src/app`: Next.js App Router pages and API routes.
- `src/app/page.tsx`: first-pass workspace UI and local project state.
- `src/app/api/chat`: optional Gemini server-side chat integration.
- `src/app/api/generate/image` and `video`: safe placeholders for provider adapters.
- `.env.local`: secrets; never commit it.
- `docs/PROGRESS.md`: source of truth for implementation progress.

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
