import { NextResponse } from "next/server";
import { deleteProject, readProject, saveProject } from "@/lib/server/storage";
import { errorResponse } from "@/lib/server/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Full project document. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    return NextResponse.json({ project: await readProject(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Replace the document: { project, revision } → { revision, updatedAt }. 409 on revision mismatch. */
export async function PUT(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { project?: unknown; revision?: unknown };
    if (!body?.project || typeof body.revision !== "number") {
      return NextResponse.json({ error: "Expected { project, revision }" }, { status: 400 });
    }
    const saved = await saveProject(id, body.project, body.revision);
    return NextResponse.json({ revision: saved.revision, updatedAt: saved.updatedAt });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Delete the project and all of its uploaded files. */
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    await deleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
