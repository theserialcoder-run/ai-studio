import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { isValidId } from "@/lib/server/storage";
import { framePath } from "@/lib/server/storycut";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; name: string }> };

/** A scene keyframe (JPEG) from the project's cache. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id, name } = await params;
    const file = isValidId(id) ? framePath(id, name) : null;
    if (!file) return NextResponse.json({ error: "Invalid frame" }, { status: 400 });
    const data = await fs.readFile(file).catch(() => null);
    if (!data) return NextResponse.json({ error: "Frame not found" }, { status: 404 });
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
