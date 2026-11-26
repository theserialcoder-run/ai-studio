// Pure helpers shared by the server (validation on load/save) and the client
// (factories, selectors, mutations). No browser or Node APIs here.
import {
  SCHEMA_VERSION, SHOT_STATUSES,
  type Asset, type AssetKind, type Character, type CharacterVariation, type ID, type Location, type LocationAngle,
  type Project, type ProjectSummary, type Scene, type Script, type Shot, type ShotCharacterRef, type ShotStatus,
  type StoryCut,
} from "./types";

export const DEFAULT_STYLE =
  "Warm vintage 1970s film still, natural light, muted earthy colours, subtle film grain, grounded cinematic realism. No text or logos.";

export const MAX_ACTIVITY = 60;

export function newId(): ID {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ factories */

export function makeScript(partial: Partial<Script> = {}): Script {
  const t = nowIso();
  return { id: newId(), title: "Untitled script", content: "", createdAt: t, updatedAt: t, ...partial };
}

export function makeScene(scriptId: ID, partial: Partial<Scene> = {}): Scene {
  const t = nowIso();
  return {
    id: newId(), scriptId, heading: "", title: "", description: "", dialogue: "",
    characterIds: [], locationId: null, createdAt: t, updatedAt: t, ...partial,
  };
}

export function makeShot(partial: Partial<Shot> = {}): Shot {
  const t = nowIso();
  return {
    id: newId(), sceneId: null, title: "", description: "", cameraAngle: "", cameraMovement: "", framing: "",
    lighting: "", mood: "", durationSec: null, status: "Planning", notes: "", characters: [], locationId: null,
    locationAngleId: null, assetIds: [], generatedAssetIds: [], createdAt: t, updatedAt: t, ...partial,
  };
}

export function makeCharacter(partial: Partial<Character> = {}): Character {
  const t = nowIso();
  return {
    id: newId(), name: "New character", description: "", appearance: "", clothing: "", personality: "", notes: "",
    referenceAssetIds: [], primaryAssetId: null, variations: [], createdAt: t, updatedAt: t, ...partial,
  };
}

export function makeVariation(partial: Partial<CharacterVariation> = {}): CharacterVariation {
  return { id: newId(), name: "New variation", description: "", assetIds: [], ...partial };
}

export function makeLocation(partial: Partial<Location> = {}): Location {
  const t = nowIso();
  return {
    id: newId(), name: "New location", description: "", architecture: "", environment: "", layout: "", lighting: "",
    visualDetails: "", referenceAssetIds: [], primaryAssetId: null, angles: [], createdAt: t, updatedAt: t, ...partial,
  };
}

export function makeAngle(partial: Partial<LocationAngle> = {}): LocationAngle {
  return { id: newId(), name: "New angle", description: "", assetIds: [], ...partial };
}

export function makeStoryCut(partial: Partial<StoryCut> = {}): StoryCut {
  const t = nowIso();
  return {
    id: newId(), title: "Untitled story", mode: "script", script: "", cast: [], lines: [], sources: [], style: "life-lesson", instructions: "",
    voice: { providerId: "kokoro", voice: "af_heart", speed: 1 }, filmVolume: 0.15, segments: [], outputAssetIds: [],
    createdAt: t, updatedAt: t, ...partial,
  };
}

export function makeProject(input: { id?: ID; name?: string; logline?: string; style?: string; starter?: boolean }): Project {
  const t = nowIso();
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? newId(),
    name: input.name?.trim() || "Untitled film",
    logline: input.logline ?? "",
    style: input.style ?? DEFAULT_STYLE,
    revision: 0,
    createdAt: t,
    updatedAt: t,
    scripts: [],
    scenes: [],
    shots: [],
    characters: [],
    locations: [],
    assets: [],
    activity: [],
    importedGenerationIds: [],
    storyCuts: [],
  };
  const script = makeScript({ title: "Main script" });
  project.scripts.push(script);
  if (input.starter) {
    const scene = makeScene(script.id, {
      heading: "INT. ROOM - MORNING", title: "Morning routine",
      description: "A quiet man goes through his ordinary morning routine.",
    });
    project.scenes.push(scene);
    project.shots.push(
      makeShot({ sceneId: scene.id, title: "Morning routine", description: "Wide establishing shot of the room in early morning light.", framing: "Wide shot", cameraAngle: "Eye level", cameraMovement: "Static", lighting: "Soft morning window light", mood: "Calm, ordinary", durationSec: 6 }),
      makeShot({ sceneId: scene.id, title: "A quiet pause", description: "Medium shot. The main character pauses and looks toward the window.", framing: "Medium shot", cameraAngle: "Eye level", cameraMovement: "Slow push in", lighting: "Soft morning window light", mood: "Uneasy stillness", durationSec: 4 }),
    );
  }
  logActivity(project, `Created project “${project.name}”`);
  return project;
}

/* --------------------------------------------------------------- normalizing */
// Coerces untrusted / older JSON into a valid Project. Used on every load and save.

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const num = (v: unknown, fallback: number): number => (typeof v === "number" && isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null);
const httpsUrl = (v: unknown): string => (typeof v === "string" && /^https:\/\/[^\s]+$/.test(v) ? v.slice(0, 2000) : "");
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const id = (v: unknown): ID => (typeof v === "string" && v ? v : newId());

export function assetKindFromMime(mime: string): AssetKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  return "other";
}

export function normalizeProject(raw: unknown): Project {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = nowIso();
  const created = str(r.createdAt, t);
  const p: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: id(r.id),
    name: str(r.name, "Untitled film") || "Untitled film",
    logline: str(r.logline),
    style: str(r.style, DEFAULT_STYLE),
    revision: typeof r.revision === "number" ? r.revision : 0,
    createdAt: created,
    updatedAt: str(r.updatedAt, created),
    scripts: arr(r.scripts).map(s => ({
      id: id(s.id), title: str(s.title, "Untitled script"), content: str(s.content),
      createdAt: str(s.createdAt, t), updatedAt: str(s.updatedAt, t),
    })),
    scenes: [],
    shots: [],
    characters: arr(r.characters).map(c => ({
      id: id(c.id), name: str(c.name, "Unnamed character"), description: str(c.description), appearance: str(c.appearance),
      clothing: str(c.clothing), personality: str(c.personality), notes: str(c.notes),
      referenceAssetIds: strArr(c.referenceAssetIds), primaryAssetId: strOrNull(c.primaryAssetId),
      variations: arr(c.variations).map(v => ({ id: id(v.id), name: str(v.name, "Variation"), description: str(v.description), assetIds: strArr(v.assetIds) })),
      createdAt: str(c.createdAt, t), updatedAt: str(c.updatedAt, t),
    })),
    locations: arr(r.locations).map(l => ({
      id: id(l.id), name: str(l.name, "Unnamed location"), description: str(l.description), architecture: str(l.architecture),
      environment: str(l.environment), layout: str(l.layout), lighting: str(l.lighting), visualDetails: str(l.visualDetails),
      referenceAssetIds: strArr(l.referenceAssetIds), primaryAssetId: strOrNull(l.primaryAssetId),
      angles: arr(l.angles).map(a => ({ id: id(a.id), name: str(a.name, "Angle"), description: str(a.description), assetIds: strArr(a.assetIds) })),
      createdAt: str(l.createdAt, t), updatedAt: str(l.updatedAt, t),
    })),
    assets: arr(r.assets).filter(a => typeof a.fileName === "string" && a.fileName).map(a => {
      const mimeType = str(a.mimeType, "application/octet-stream");
      return {
        id: id(a.id), name: str(a.name, "file"), kind: (["image", "video", "audio", "document", "other"] as const).includes(a.kind as AssetKind) ? (a.kind as AssetKind) : assetKindFromMime(mimeType),
        mimeType, size: typeof a.size === "number" ? a.size : 0, fileName: str(a.fileName), tags: strArr(a.tags), notes: str(a.notes),
        createdAt: str(a.createdAt, t),
      } satisfies Asset;
    }),
    activity: arr(r.activity).map(e => ({ id: id(e.id), at: str(e.at, t), message: str(e.message) })).slice(0, MAX_ACTIVITY),
    importedGenerationIds: strArr(r.importedGenerationIds).slice(-1000),
    storyCuts: [],
  };

  if (p.scripts.length === 0) p.scripts.push(makeScript({ title: "Main script" }));
  const scriptIds = new Set(p.scripts.map(s => s.id));
  const characterIds = new Set(p.characters.map(c => c.id));
  const locationIds = new Set(p.locations.map(l => l.id));

  p.scenes = arr(r.scenes).map(s => ({
    id: id(s.id), scriptId: scriptIds.has(str(s.scriptId)) ? str(s.scriptId) : p.scripts[0].id,
    heading: str(s.heading), title: str(s.title), description: str(s.description), dialogue: str(s.dialogue),
    characterIds: strArr(s.characterIds).filter(c => characterIds.has(c)),
    locationId: locationIds.has(str(s.locationId)) ? str(s.locationId) : null,
    createdAt: str(s.createdAt, t), updatedAt: str(s.updatedAt, t),
  }));
  const sceneIds = new Set(p.scenes.map(s => s.id));

  p.shots = arr(r.shots).map(s => {
    const locationId = locationIds.has(str(s.locationId)) ? str(s.locationId) : null;
    const loc = p.locations.find(l => l.id === locationId);
    const angleId = strOrNull(s.locationAngleId);
    const characters: ShotCharacterRef[] = arr(s.characters)
      .filter(c => characterIds.has(str(c.characterId)))
      .map(c => {
        const ch = p.characters.find(x => x.id === c.characterId)!;
        const variationId = strOrNull(c.variationId);
        return { characterId: ch.id, variationId: variationId && ch.variations.some(v => v.id === variationId) ? variationId : null };
      });
    const duration = typeof s.durationSec === "number" && isFinite(s.durationSec) && s.durationSec >= 0 ? s.durationSec : null;
    return {
      id: id(s.id), sceneId: sceneIds.has(str(s.sceneId)) ? str(s.sceneId) : null,
      title: str(s.title), description: str(s.description), cameraAngle: str(s.cameraAngle), cameraMovement: str(s.cameraMovement),
      framing: str(s.framing), lighting: str(s.lighting), mood: str(s.mood), durationSec: duration,
      status: SHOT_STATUSES.includes(s.status as ShotStatus) ? (s.status as ShotStatus) : "Planning",
      notes: str(s.notes), characters, locationId,
      locationAngleId: loc && angleId && loc.angles.some(a => a.id === angleId) ? angleId : null,
      assetIds: strArr(s.assetIds), generatedAssetIds: strArr(s.generatedAssetIds), createdAt: str(s.createdAt, t), updatedAt: str(s.updatedAt, t),
    } satisfies Shot;
  });

  // Drop dangling asset references.
  const assetIds = new Set(p.assets.map(a => a.id));
  const keep = (ids: ID[]) => ids.filter(a => assetIds.has(a));
  for (const c of p.characters) {
    c.referenceAssetIds = keep(c.referenceAssetIds);
    if (c.primaryAssetId && !assetIds.has(c.primaryAssetId)) c.primaryAssetId = null;
    for (const v of c.variations) v.assetIds = keep(v.assetIds);
  }
  for (const l of p.locations) {
    l.referenceAssetIds = keep(l.referenceAssetIds);
    if (l.primaryAssetId && !assetIds.has(l.primaryAssetId)) l.primaryAssetId = null;
    for (const a of l.angles) a.assetIds = keep(a.assetIds);
  }
  for (const s of p.shots) { s.assetIds = keep(s.assetIds); s.generatedAssetIds = keep(s.generatedAssetIds); }

  p.storyCuts = arr(r.storyCuts).map(c => {
    const v = (c.voice && typeof c.voice === "object" ? c.voice : {}) as Record<string, unknown>;
    const segIds = new Set(arr(c.segments).filter(s => assetIds.has(str(s.assetId))).map(s => str(s.id)));
    return {
      id: id(c.id), title: str(c.title, "Untitled story"),
      mode: c.mode === "script" || c.mode === "stock" ? c.mode : "story",
      script: str(c.script),
      cast: arr(c.cast).map(m => ({ name: str(m.name), look: str(m.look) })).filter(m => m.name || m.look).slice(0, 30),
      lines: arr(c.lines).map(l => ({
        id: id(l.id), text: str(l.text),
        sceneId: segIds.has(str(l.sceneId)) ? str(l.sceneId) : null,
        options: strArr(l.options).filter(o => segIds.has(o)).slice(0, 5),
        query: str(l.query).slice(0, 200),
        stock: arr(l.stock).map(o => ({
          id: str(o.id), kind: o.kind === "photo" ? "photo" as const : "video" as const,
          thumb: str(o.thumb), duration: Math.max(0, num(o.duration, 0)), width: Math.max(0, num(o.width, 0)), height: Math.max(0, num(o.height, 0)),
          pageUrl: httpsUrl(o.pageUrl), author: str(o.author).slice(0, 120), authorUrl: httpsUrl(o.authorUrl), fileUrl: httpsUrl(o.fileUrl), query: str(o.query).slice(0, 200),
        })).filter(o => o.id && /^[A-Za-z0-9_-]{1,80}\.jpg$/.test(o.thumb)).slice(0, 8),
      })),
      sources: arr(c.sources).filter(s => assetIds.has(str(s.assetId))).map(s => ({ assetId: str(s.assetId), start: numOrNull(s.start), end: numOrNull(s.end) })),
      style: str(c.style, "life-lesson"), instructions: str(c.instructions),
      voice: { providerId: str(v.providerId, "kokoro"), voice: str(v.voice, "af_heart"), speed: clamp(num(v.speed, 1), 0.5, 2) },
      filmVolume: clamp(num(c.filmVolume, 0.15), 0, 1),
      segments: arr(c.segments).filter(s => assetIds.has(str(s.assetId))).map(s => {
        const start = Math.max(0, num(s.start, 0));
        return {
          id: id(s.id), assetId: str(s.assetId), start, end: Math.max(start + 0.1, num(s.end, start + 1)),
          frames: strArr(s.frames).filter(f => /^[A-Za-z0-9_-]{1,80}\.jpg$/.test(f)).slice(0, 4),
          description: str(s.description), narration: str(s.narration), skip: s.skip === true,
        };
      }),
      outputAssetIds: keep(strArr(c.outputAssetIds)),
      createdAt: str(c.createdAt, t), updatedAt: str(c.updatedAt, t),
    } satisfies StoryCut;
  });
  return p;
}

export function summarize(p: Project): ProjectSummary {
  return {
    id: p.id, name: p.name, logline: p.logline, updatedAt: p.updatedAt, createdAt: p.createdAt,
    counts: {
      scripts: p.scripts.length, scenes: p.scenes.length, shots: p.shots.length,
      characters: p.characters.length, locations: p.locations.length, assets: p.assets.length,
    },
  };
}

/* ----------------------------------------------------------------- selectors */

export function scenesOf(p: Project, scriptId: ID): Scene[] {
  return p.scenes.filter(s => s.scriptId === scriptId);
}

export function shotsOf(p: Project, sceneId: ID | null): Shot[] {
  return p.shots.filter(s => s.sceneId === sceneId);
}

/** 1-based scene number within its script. */
export function sceneNumber(p: Project, sceneId: ID): number {
  const scene = p.scenes.find(s => s.id === sceneId);
  if (!scene) return 0;
  return scenesOf(p, scene.scriptId).findIndex(s => s.id === sceneId) + 1;
}

/** Derived shot number such as "3.2" (scene 3, shot 2) or "U.4" for unassigned shots. */
export function shotNumber(p: Project, shot: Shot): string {
  const index = shotsOf(p, shot.sceneId).findIndex(s => s.id === shot.id) + 1;
  return shot.sceneId ? `${sceneNumber(p, shot.sceneId)}.${index}` : `U.${index}`;
}

export function sceneLabel(p: Project, scene: Scene): string {
  const n = String(sceneNumber(p, scene.id)).padStart(2, "0");
  return `Scene ${n}${scene.heading ? ` · ${scene.heading}` : scene.title ? ` · ${scene.title}` : ""}`;
}

export function assetById(p: Project, assetId: ID | null | undefined): Asset | undefined {
  return assetId ? p.assets.find(a => a.id === assetId) : undefined;
}

export function fileUrl(projectId: ID, assetId: ID): string {
  return `/api/projects/${projectId}/files/${assetId}`;
}

/** Every record that references an asset — used by the asset library's "Used by". */
export function assetUsage(p: Project, assetId: ID): string[] {
  const uses: string[] = [];
  for (const c of p.characters) {
    if (c.referenceAssetIds.includes(assetId)) uses.push(`Character: ${c.name}`);
    for (const v of c.variations) if (v.assetIds.includes(assetId)) uses.push(`Character: ${c.name} · ${v.name}`);
  }
  for (const l of p.locations) {
    if (l.referenceAssetIds.includes(assetId)) uses.push(`Location: ${l.name}`);
    for (const a of l.angles) if (a.assetIds.includes(assetId)) uses.push(`Location: ${l.name} · ${a.name}`);
  }
  for (const s of p.shots) if (s.assetIds.includes(assetId)) uses.push(`Shot ${shotNumber(p, s)}${s.title ? ` · ${s.title}` : ""}`);
  for (const s of p.shots) if (s.generatedAssetIds.includes(assetId)) uses.push(`Shot ${shotNumber(p, s)} take`);
  for (const c of p.storyCuts) {
    if (c.sources.some(s => s.assetId === assetId)) uses.push(`Story cut: ${c.title} (footage)`);
    else if (c.segments.some(s => s.assetId === assetId)) uses.push(`Story cut: ${c.title} (clip)`);
    if (c.outputAssetIds.includes(assetId)) uses.push(`Story cut: ${c.title} (render)`);
  }
  return uses;
}

/* ------------------------------------------------------------------ mutations */
// These mutate the draft passed in (the client always works on a clone).

export function logActivity(p: Project, message: string) {
  const at = nowIso();
  const last = p.activity[0];
  // Collapse repeated edits of the same thing within 10 minutes into one entry.
  if (last && last.message === message && Date.parse(at) - Date.parse(last.at) < 10 * 60 * 1000) {
    last.at = at;
    return;
  }
  p.activity.unshift({ id: newId(), at, message });
  if (p.activity.length > MAX_ACTIVITY) p.activity.length = MAX_ACTIVITY;
}

/**
 * Move an item one step up/down among the items that match `group`
 * (e.g. shots of the same scene) while keeping the global array order intact.
 */
export function moveWithinGroup<T extends { id: ID }>(list: T[], itemId: ID, dir: -1 | 1, group: (x: T) => boolean) {
  const indices = list.map((x, i) => (group(x) ? i : -1)).filter(i => i >= 0);
  const pos = indices.findIndex(i => list[i].id === itemId);
  const target = pos + dir;
  if (pos < 0 || target < 0 || target >= indices.length) return;
  const a = indices[pos], b = indices[target];
  [list[a], list[b]] = [list[b], list[a]];
}

export function removeCharacter(p: Project, characterId: ID) {
  p.characters = p.characters.filter(c => c.id !== characterId);
  for (const s of p.scenes) s.characterIds = s.characterIds.filter(c => c !== characterId);
  for (const s of p.shots) s.characters = s.characters.filter(c => c.characterId !== characterId);
}

export function removeVariation(p: Project, characterId: ID, variationId: ID) {
  const c = p.characters.find(x => x.id === characterId);
  if (!c) return;
  c.variations = c.variations.filter(v => v.id !== variationId);
  for (const s of p.shots) for (const ref of s.characters) if (ref.variationId === variationId) ref.variationId = null;
}

export function removeLocation(p: Project, locationId: ID) {
  p.locations = p.locations.filter(l => l.id !== locationId);
  for (const s of p.scenes) if (s.locationId === locationId) s.locationId = null;
  for (const s of p.shots) if (s.locationId === locationId) { s.locationId = null; s.locationAngleId = null; }
}

export function removeAngle(p: Project, locationId: ID, angleId: ID) {
  const l = p.locations.find(x => x.id === locationId);
  if (!l) return;
  l.angles = l.angles.filter(a => a.id !== angleId);
  for (const s of p.shots) if (s.locationAngleId === angleId) s.locationAngleId = null;
}

/** Deleting a scene keeps its shots: they become unassigned. */
export function removeScene(p: Project, sceneId: ID) {
  p.scenes = p.scenes.filter(s => s.id !== sceneId);
  for (const s of p.shots) if (s.sceneId === sceneId) s.sceneId = null;
}

export function removeScript(p: Project, scriptId: ID) {
  for (const scene of scenesOf(p, scriptId)) removeScene(p, scene.id);
  p.scripts = p.scripts.filter(s => s.id !== scriptId);
}

/** Removes the asset record and every reference to it. The server deletes the file on save. */
export function removeAsset(p: Project, assetId: ID) {
  p.assets = p.assets.filter(a => a.id !== assetId);
  for (const c of p.characters) {
    c.referenceAssetIds = c.referenceAssetIds.filter(a => a !== assetId);
    if (c.primaryAssetId === assetId) c.primaryAssetId = c.referenceAssetIds[0] ?? null;
    for (const v of c.variations) v.assetIds = v.assetIds.filter(a => a !== assetId);
  }
  for (const l of p.locations) {
    l.referenceAssetIds = l.referenceAssetIds.filter(a => a !== assetId);
    if (l.primaryAssetId === assetId) l.primaryAssetId = l.referenceAssetIds[0] ?? null;
    for (const a of l.angles) a.assetIds = a.assetIds.filter(x => x !== assetId);
  }
  for (const s of p.shots) {
    s.assetIds = s.assetIds.filter(a => a !== assetId);
    s.generatedAssetIds = s.generatedAssetIds.filter(a => a !== assetId);
  }
  for (const c of p.storyCuts) {
    c.sources = c.sources.filter(s => s.assetId !== assetId);
    c.segments = c.segments.filter(s => s.assetId !== assetId);
    const segIds = new Set(c.segments.map(s => s.id));
    for (const l of c.lines) {
      if (l.sceneId && !segIds.has(l.sceneId)) l.sceneId = null;
      l.options = l.options.filter(o => segIds.has(o));
    }
    c.outputAssetIds = c.outputAssetIds.filter(a => a !== assetId);
  }
}

/** Split screenplay text into scenes at INT./EXT. sluglines. */
export function parseScenesFromScreenplay(text: string): { heading: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const slug = /^\s*(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.|EXT\.)\s+/i;
  const out: { heading: string; body: string[] }[] = [];
  for (const line of lines) {
    if (slug.test(line)) out.push({ heading: line.trim(), body: [] });
    else if (out.length) out[out.length - 1].body.push(line);
  }
  return out.map(s => ({ heading: s.heading, body: s.body.join("\n").trim() }));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
