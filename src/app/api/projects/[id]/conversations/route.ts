import { NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/server/assistant";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return NextResponse.json({ conversations: await listConversations(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ conversation: await createConversation(id, typeof body?.title === "string" ? body.title : undefined) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
