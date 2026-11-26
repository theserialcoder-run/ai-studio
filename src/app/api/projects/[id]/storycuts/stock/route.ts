import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { stockSearchLine, stockSwap } from "@/lib/server/storycut";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Stock mode, per line:
 *  { action: "swap", cutId, lineId, optionId } → { asset, segment } (downloads that clip)
 *  { action: "search", cutId, lineId, query, kind? } → { options, query } (thumbnails only)
 * Nothing is saved to the project; the client applies the result.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (body.action === "swap") return NextResponse.json(await stockSwap(id, body));
    if (body.action === "search") return NextResponse.json(await stockSearchLine(id, body));
    return NextResponse.json({ error: "action must be swap or search" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
