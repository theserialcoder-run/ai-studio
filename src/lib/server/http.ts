import { NextResponse } from "next/server";
import { ProviderError } from "./ai/http";
import { StorageError } from "./storage";

export function errorResponse(e: unknown) {
  if (e instanceof StorageError || e instanceof ProviderError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(e);
  return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
}
