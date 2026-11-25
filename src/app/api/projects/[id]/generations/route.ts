import { NextResponse } from "next/server";
import { listGenerations, startGeneration } from "@/lib/server/generations";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Generation history for the project (newest first), with live progress for running jobs. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return NextResponse.json({ generations: await listGenerations(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Start a generation job: GenerationRequest + { label } → 202 { generation }. Paid providers need approvedPaid: true. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json();
    const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80).replace(/[\\/:*?"<>|]/g, "-") : "Generated";
    return NextResponse.json({ generation: await startGeneration(id, body, label) }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
