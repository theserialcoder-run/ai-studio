import { NextResponse } from "next/server";
import { StorageError } from "./storage";

export function errorResponse(e: unknown) {
  if (e instanceof StorageError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(e);
  return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
}
