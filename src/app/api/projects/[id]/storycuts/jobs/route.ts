import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { mediaTools } from "@/lib/server/media";
import { stockConfigured, stockProviderName } from "@/lib/server/stock";
import { listStoryJobs, startStoryJob } from "@/lib/server/storycut";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Story Cut jobs (newest first) with live progress, plus whether ffmpeg is installed. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const [jobs, tools] = await Promise.all([listStoryJobs(id), mediaTools()]);
    return NextResponse.json({ jobs, tools: { ...tools, stock: stockConfigured() ? stockProviderName() : null } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Start `{ kind: "detect" | "describe" | "render", cutId, overwrite?, sensitivity? }` → 202 { job }. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ job: await startStoryJob(id, body) }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
