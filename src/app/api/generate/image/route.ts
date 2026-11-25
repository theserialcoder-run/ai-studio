import { NextResponse } from "next/server";
import { describeReferences } from "@/lib/server/generation";

// Provider-independent placeholder. Body: { prompt, userPrompt, continuity: ContinuityBundle }
// (see src/lib/continuity.ts). Implement a provider adapter here; never expose provider keys to the browser.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const refs = describeReferences(body);
  if (!process.env.IMAGE_API_URL || !process.env.IMAGE_API_KEY) {
    return NextResponse.json({
      status: "not_configured",
      message: `Image generation provider is not connected yet. ${refs} Configure IMAGE_API_URL and IMAGE_API_KEY after choosing a provider.`,
    });
  }
  return NextResponse.json({
    status: "adapter_required",
    message: `Provider credentials detected, but this starter does not assume a provider-specific request format. ${refs} Implement the adapter described in docs/PROVIDERS.md before sending paid requests.`,
    receivedPrompt: typeof body.prompt === "string" ? body.prompt.slice(0, 200) : "",
  });
}
