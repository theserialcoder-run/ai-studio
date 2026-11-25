import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/server/http";
import { writeStory } from "@/lib/server/storycut";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Write narration for a cut: `{ cutId, style?, instructions? }` → StoryDraft + provider. Nothing is saved; the client applies it. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return NextResponse.json(await writeStory(id, await req.json().catch(() => ({}))));
  } catch (e) {
    return errorResponse(e);
  }
}
