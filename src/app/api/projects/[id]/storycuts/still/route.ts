import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { isValidId } from "@/lib/server/storage";
import { stillFrame } from "@/lib/server/storycut";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET ?asset=<assetId>&t=<seconds>: a frame of a footage video at that time (JPEG, cached). */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    if (!isValidId(id)) return NextResponse.json({ error: "Invalid project" }, { status: 400 });
    const file = await stillFrame(id, url.searchParams.get("asset") ?? "", Number(url.searchParams.get("t")));
    const data = await fs.readFile(file);
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
