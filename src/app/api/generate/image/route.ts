import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json();
  // Provider-independent placeholder: implement a provider adapter here.
  // Never expose provider API keys to the browser.
  if (!process.env.IMAGE_API_URL || !process.env.IMAGE_API_KEY) {
    return NextResponse.json({
      status: "not_configured",
      message: "Image generation provider is not connected yet. Your prompt and continuity references are ready. Configure IMAGE_API_URL and IMAGE_API_KEY after choosing a provider."
    });
  }
  return NextResponse.json({
    status: "adapter_required",
    message: "Provider credentials detected, but this starter does not assume a provider-specific request format. Implement the adapter described in docs/PROVIDERS.md before sending paid requests.",
    receivedPrompt: typeof body.prompt === "string" ? body.prompt.slice(0, 200) : ""
  });
}
