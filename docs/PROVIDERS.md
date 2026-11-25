# Provider integration guide

The starter deliberately does not assume one vendor's request format. This avoids accidentally sending paid requests or exposing credentials.

## Gemini chat
1. Create an API key in Google AI Studio.
2. Copy `.env.example` to `.env.local`.
3. Set `GEMINI_API_KEY=...`.
4. Restart `npm run dev`.

The current chat route uses Gemini's `generateContent` API. Check current model names, free-tier quotas, regional availability and data-use terms before production use.

## Image generation
Choose a provider/model after checking:
- Does it provide hosted inference or only downloadable weights?
- Does it offer a free quota, and what are the limits?
- Does it support reference image input / image-to-image?
- Does it permit commercial use under its license?
- What are resolution, queue, timeout and output URL rules?

Then implement the request in `src/app/api/generate/image/route.ts`. The route already receives `{ prompt, userPrompt, continuity }`, where `continuity` is a `ContinuityBundle` (`src/lib/continuity.ts`) with character/location records and reference image URLs (`/api/projects/<id>/files/<assetId>`; read the files server-side from `data/projects/<id>/files/`). Keep API keys server-side. Normalize results to `{ status, message, jobId?, outputUrl? }`.

## Video generation
Follow the same process in `src/app/api/generate/video/route.ts`. Prefer asynchronous jobs:
- submit job
- store provider job ID
- poll status or receive webhook
- save output to durable object storage
- record model, prompt, seed, duration and cost

Never launch a GPU workload automatically when a page loads. Require an explicit Generate click and show estimated cost/limits first.

## Free services
Free tiers and hosted inference quotas change frequently. Verify provider pricing, terms, model license, regional availability and rate limits before integrating. A public model page (for example Hugging Face) is not itself a promise of free hosted inference.
