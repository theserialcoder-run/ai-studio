import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { matchScript, suggestCast } from "@/lib/server/storycut";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Script mode: `{ cutId, action: "cast" | "match" }`. Nothing is saved; the client applies the result. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (body.action === "cast") return NextResponse.json(await suggestCast(id, body));
    if (body.action === "match") return NextResponse.json(await matchScript(id, body));
    return NextResponse.json({ error: "action must be cast or match" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
