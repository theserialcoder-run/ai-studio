import { NextResponse } from "next/server";
import { storeUpload } from "@/lib/server/storage";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Upload one or more files (multipart field "files"). Returns the new asset
 * records; the client adds them to the project document and links them.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (files.length === 0) return NextResponse.json({ error: "No files received" }, { status: 400 });
    const assets = [];
    for (const file of files) assets.push(await storeUpload(id, file));
    return NextResponse.json({ assets }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
