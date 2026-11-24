import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json();
  if (!process.env.VIDEO_API_URL || !process.env.VIDEO_API_KEY) {
    return NextResponse.json({
      status: "not_configured",
      message: "Video generation provider is not connected yet. No GPU has been started and no charge has been made. Choose and configure a provider before enabling generation."
    });
  }
  return NextResponse.json({
    status: "adapter_required",
    message: "Provider credentials detected, but a provider-specific adapter must be implemented before generation.",
    receivedPrompt: typeof body.prompt === "string" ? body.prompt.slice(0, 200) : ""
  });
}
