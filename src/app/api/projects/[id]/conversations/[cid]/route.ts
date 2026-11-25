import { NextResponse } from "next/server";
import { deleteConversation, renameConversation } from "@/lib/server/assistant";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; cid: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id, cid } = await params;
    const body = await req.json();
    await renameConversation(id, cid, String(body?.title ?? ""));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id, cid } = await params;
    await deleteConversation(id, cid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
