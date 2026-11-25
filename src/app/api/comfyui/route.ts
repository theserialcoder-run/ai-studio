import { NextResponse } from "next/server";
import { comfyStatus, validComfyUrl } from "@/lib/server/ai/comfyui";
import { errorResponse } from "@/lib/server/http";
import { updateSettings } from "@/lib/server/settings";

export const dynamic = "force-dynamic";

/** Connection status. `?check=1` also contacts ComfyUI (GPU, version, installed models). Never returns the auth header. */
export async function GET(req: Request) {
  try {
    const check = new URL(req.url).searchParams.get("check") === "1";
    return NextResponse.json(await comfyStatus(check));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Save `{ url, authHeader? , clearAuth? }`. An empty url disconnects. */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { url?: unknown; authHeader?: unknown; clearAuth?: unknown };
    const url = typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
    if (url && !validComfyUrl(url)) return NextResponse.json({ error: "Enter a full http:// or https:// address, e.g. https://abc123-8188.proxy.runpod.net" }, { status: 400 });
    await updateSettings(s => {
      s.comfyui.url = url;
      if (body.clearAuth === true || !url) s.comfyui.authHeader = "";
      else if (typeof body.authHeader === "string" && body.authHeader.trim()) s.comfyui.authHeader = body.authHeader.trim().slice(0, 2000);
    });
    return NextResponse.json(await comfyStatus(false));
  } catch (e) {
    return errorResponse(e);
  }
}
