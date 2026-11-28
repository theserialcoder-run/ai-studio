import { NextResponse } from "next/server";
import { sendMessage } from "@/lib/server/assistant";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; cid: string }> };

/** { message, focus? } → { conversation, provider }. Uses the saved project as live context. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id, cid } = await params;
    const body = await req.json();
    const focus = body?.focus && typeof body.focus === "object" ? body.focus : {};
    return NextResponse.json(await sendMessage(id, cid, String(body?.message ?? "").slice(0, 20000), focus, req.signal));
  } catch (e) {
    return errorResponse(e);
  }
}
