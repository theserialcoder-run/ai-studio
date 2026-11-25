import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/server/storage";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** List project summaries. */
export async function GET() {
  try {
    return NextResponse.json(await listProjects());
  } catch (e) {
    return errorResponse(e);
  }
}

/** Create a project: { name?, logline?, style?, starter? } → full project. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.slice(0, 5000) : undefined);
    const project = await createProject({ name: s(body.name), logline: s(body.logline), style: s(body.style), starter: body.starter === true });
    return NextResponse.json({ project }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
