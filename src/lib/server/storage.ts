// File-system persistence. Server-only (imports node:fs) — never import from client code.
//
// Layout (root defaults to <cwd>/data, override with WONDERBOY_DATA_DIR):
//   data/projects/<projectId>/project.json       current document
//   data/projects/<projectId>/project.json.bak   previous saved version
//   data/projects/<projectId>/files/<assetId>.<ext>  uploaded files
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assetKindFromMime, makeProject, normalizeProject, nowIso, summarize } from "../projectModel";
import type { Asset, Project, ProjectSummary } from "../types";

const ROOT = path.resolve(process.env.WONDERBOY_DATA_DIR || path.join(process.cwd(), "data"));
const PROJECTS = path.join(ROOT, "projects");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export class StorageError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function projectDir(id: string) {
  if (!isValidId(id)) throw new StorageError("Invalid project id", 400);
  return path.join(PROJECTS, id);
}
const docPath = (id: string) => path.join(projectDir(id), "project.json");
const filesDir = (id: string) => path.join(projectDir(id), "files");

// Serialize writes per project so concurrent requests can't interleave.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  if (await exists(file)) await fs.copyFile(file, `${file}.bak`);
  await fs.rename(tmp, file);
}

export async function readProject(id: string): Promise<Project> {
  let raw: string;
  try {
    raw = await fs.readFile(docPath(id), "utf8");
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw new StorageError("Project not found", 404);
  }
  try {
    return normalizeProject(JSON.parse(raw));
  } catch {
    throw new StorageError("Project file is corrupted. A previous version is kept in project.json.bak.", 500);
  }
}

/** Lists projects. `firstRun` is true only when the data folder did not exist yet. */
export async function listProjects(): Promise<{ projects: ProjectSummary[]; firstRun: boolean }> {
  const firstRun = !(await exists(PROJECTS));
  await fs.mkdir(PROJECTS, { recursive: true });
  const entries = await fs.readdir(PROJECTS, { withFileTypes: true });
  const projects: ProjectSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidId(e.name)) continue;
    try { projects.push(summarize(await readProject(e.name))); } catch { /* skip unreadable */ }
  }
  projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { projects, firstRun };
}

export async function createProject(input: { name?: string; logline?: string; style?: string; starter?: boolean }): Promise<Project> {
  const project = makeProject(input);
  await fs.mkdir(filesDir(project.id), { recursive: true });
  project.revision = 1;
  await writeAtomic(docPath(project.id), JSON.stringify(project, null, 2));
  return project;
}

/**
 * Replaces the project document. `expectedRevision` must match the stored
 * revision (optimistic concurrency); files of assets removed from the
 * document are deleted from disk.
 */
export async function saveProject(id: string, incoming: unknown, expectedRevision: number): Promise<Project> {
  return withLock(id, async () => {
    const current = await readProject(id);
    if (current.revision !== expectedRevision) {
      throw new StorageError("This project was changed somewhere else (another tab?). Reload to get the latest version.", 409);
    }
    const next = normalizeProject(incoming);
    next.id = id;
    next.createdAt = current.createdAt;
    next.revision = current.revision + 1;
    next.updatedAt = nowIso();
    await writeAtomic(docPath(id), JSON.stringify(next, null, 2));

    const kept = new Set(next.assets.map(a => a.id));
    for (const a of current.assets) {
      if (!kept.has(a.id)) await fs.rm(path.join(filesDir(id), path.basename(a.fileName)), { force: true });
    }
    return next;
  });
}

export async function deleteProject(id: string): Promise<void> {
  return withLock(id, async () => {
    if (!(await exists(docPath(id)))) throw new StorageError("Project not found", 404);
    await fs.rm(projectDir(id), { recursive: true, force: true });
  });
}

/* --------------------------------------------------------------------- files */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", fountain: "text/plain",
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function extensionFor(name: string, mime: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  if (m) return m[1].toLowerCase();
  return EXT_BY_MIME[mime] ?? "bin";
}

export function mimeForFile(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Stores an uploaded file and returns its asset record. The client adds the record to the project. */
export async function storeUpload(projectId: string, file: File): Promise<Asset> {
  if (!(await exists(docPath(projectId)))) throw new StorageError("Project not found", 404);
  if (file.size > MAX_UPLOAD_BYTES) throw new StorageError(`${file.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 413);
  const id = randomUUID();
  const ext = extensionFor(file.name, file.type);
  const fileName = `${id}.${ext}`;
  const mimeType = file.type || mimeForFile(fileName);
  await fs.mkdir(filesDir(projectId), { recursive: true });
  await fs.writeFile(path.join(filesDir(projectId), fileName), Buffer.from(await file.arrayBuffer()));
  return {
    id, name: file.name || fileName, kind: assetKindFromMime(mimeType), mimeType, size: file.size, fileName,
    tags: [], notes: "", createdAt: nowIso(),
  };
}

/** Resolves an asset id to its file on disk (looked up by id prefix, so it works before the document is saved). */
export async function findFile(projectId: string, assetId: string): Promise<{ filePath: string; size: number; mimeType: string } | null> {
  if (!isValidId(assetId)) return null;
  let names: string[];
  try { names = await fs.readdir(filesDir(projectId)); } catch { return null; }
  const name = names.find(n => n.startsWith(`${assetId}.`));
  if (!name) return null;
  const filePath = path.join(filesDir(projectId), name);
  const stat = await fs.stat(filePath);
  return { filePath, size: stat.size, mimeType: mimeForFile(name) };
}

export function dataRoot() {
  return ROOT;
}

/* ------------------------------------------------------- side documents */
// Small JSON files next to project.json that the server owns (the client never
// PUTs them), so they don't conflict with the client's revision-checked saves.

export async function readSideFile<T>(projectId: string, name: "generations" | "conversations", fallback: T): Promise<T> {
  if (!(await exists(docPath(projectId)))) throw new StorageError("Project not found", 404);
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir(projectId), `${name}.json`), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Read-modify-write a side file under the project lock. */
export async function updateSideFile<T>(projectId: string, name: "generations" | "conversations", fallback: T, fn: (current: T) => T | Promise<T>): Promise<T> {
  return withLock(`${projectId}:${name}`, async () => {
    const current = await readSideFile(projectId, name, fallback);
    const next = await fn(current);
    await writeAtomic(path.join(projectDir(projectId), `${name}.json`), JSON.stringify(next, null, 2));
    return next;
  });
}

/** Saves generated media into the project's files folder and returns its asset record. */
export async function saveGeneratedFile(projectId: string, data: Buffer, mimeType: string, displayName: string): Promise<Asset> {
  if (!(await exists(docPath(projectId)))) throw new StorageError("The project was deleted before the generation finished.", 404);
  const id = randomUUID();
  const ext = EXT_BY_MIME[mimeType] ?? (mimeType.startsWith("video/") ? "mp4" : "png");
  const fileName = `${id}.${ext}`;
  await fs.mkdir(filesDir(projectId), { recursive: true });
  await fs.writeFile(path.join(filesDir(projectId), fileName), data);
  return {
    id, name: `${displayName}.${ext}`, kind: assetKindFromMime(mimeType), mimeType, size: data.length, fileName,
    tags: ["generated"], notes: "", createdAt: nowIso(),
  };
}
