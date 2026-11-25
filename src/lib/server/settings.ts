// Server-side app settings that the user edits in the browser (Settings view) and that
// must not live in the project document: currently the ComfyUI GPU connection.
// Stored in data/settings.json (git-ignored). Secrets are never sent back to the browser.
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot, writeAtomic } from "./storage";

export interface ServerSettings {
  comfyui: { url: string; authHeader: string };
}

const EMPTY: ServerSettings = { comfyui: { url: "", authHeader: "" } };
const file = () => path.join(dataRoot(), "settings.json");

let cache: ServerSettings | null = null;

function normalize(raw: unknown): ServerSettings {
  const c = (raw as { comfyui?: Record<string, unknown> } | null)?.comfyui ?? {};
  return {
    comfyui: {
      url: typeof c.url === "string" ? c.url.trim() : "",
      authHeader: typeof c.authHeader === "string" ? c.authHeader.trim() : "",
    },
  };
}

/** Synchronous so provider `info()` can read it; cached after the first read. */
export function getSettings(): ServerSettings {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(readFileSync(file(), "utf8")));
  } catch {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

export async function updateSettings(fn: (s: ServerSettings) => void): Promise<ServerSettings> {
  const next = structuredClone(getSettings());
  fn(next);
  await fs.mkdir(dataRoot(), { recursive: true });
  await writeAtomic(file(), JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
