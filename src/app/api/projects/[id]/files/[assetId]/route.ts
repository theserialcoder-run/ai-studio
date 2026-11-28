import { NextResponse } from "next/server";
import { findFile, isValidId } from "@/lib/server/storage";
import { errorResponse } from "@/lib/server/http";
import { fileStream } from "@/lib/server/fileStream";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; assetId: string }> };

const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf$)/;

/** Streams an uploaded file. Supports HTTP Range so videos can seek. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id, assetId } = await params;
    if (!isValidId(id) || !isValidId(assetId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    const file = await findFile(id, assetId);
    if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const headers: Record<string, string> = {
      "Content-Type": file.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable", // asset files never change
      "X-Content-Type-Options": "nosniff",
      // Audio/video can't run scripts; sandboxing them only breaks the browser's built-in player when opened in a tab.
      "Content-Security-Policy": `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'${/^(audio|video)\//.test(file.mimeType) ? "" : "; sandbox"}`,
      "Content-Disposition": INLINE.test(file.mimeType) ? "inline" : "attachment",
    };

    const range = req.headers.get("range");
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : file.size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : file.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, file.size - 1);
      if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
      const stream = fileStream(file.filePath, { start, end });
      return new Response(stream, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": String(end - start + 1) },
      });
    }
    const stream = fileStream(file.filePath);
    return new Response(stream, { headers: { ...headers, "Content-Length": String(file.size) } });
  } catch (e) {
    return errorResponse(e);
  }
}
