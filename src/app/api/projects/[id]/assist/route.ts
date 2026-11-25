import { NextResponse } from "next/server";
import { runAssist } from "@/lib/server/assistant";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Script assistant: { task, instructions?, focus? } → { summary, proposals, provider }. Nothing is applied server-side. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json();
    const focus = body?.focus && typeof body.focus === "object" ? body.focus : {};
    return NextResponse.json(await runAssist(id, String(body?.task ?? ""), String(body?.instructions ?? ""), focus));
  } catch (e) {
    return errorResponse(e);
  }
}
