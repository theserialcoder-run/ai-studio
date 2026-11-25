import { NextResponse } from "next/server";
import type { ProvidersResponse } from "@/lib/ai/types";
import { audioProviders } from "@/lib/server/ai/audio";
import { imageProviders } from "@/lib/server/ai/image";
import { activeLlm, llmProviders } from "@/lib/server/ai/llm";
import { videoProviders } from "@/lib/server/ai/video";

export const dynamic = "force-dynamic";

/** Provider registry with configuration status and capabilities. Never includes secrets. */
export async function GET() {
  const body: ProvidersResponse = {
    llm: llmProviders(),
    activeLlm: activeLlm()?.info().id ?? null,
    image: imageProviders().map(p => p.info()),
    video: videoProviders().map(p => p.info()),
    audio: audioProviders().map(p => p.info()),
  };
  return NextResponse.json(body);
}
