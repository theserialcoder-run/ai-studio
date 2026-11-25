// AI suggestions are returned as Proposals: typed, validated change sets that
// the user reviews before anything touches the project. Pure module.
import { makeCharacter, makeLocation, makeScene, makeScript, makeShot, nowIso, scenesOf } from "./projectModel";
import type { ID, Project, ShotCharacterRef } from "./types";

export interface SceneDraft { heading: string; title: string; description: string; dialogue: string; characterNames: string[]; locationName: string }
export interface ShotDraft {
  title: string; description: string; framing: string; cameraAngle: string; cameraMovement: string;
  lighting: string; mood: string; durationSec: number | null; characterNames: string[]; locationName: string;
}
export interface CharacterDraft { name: string; description: string; appearance: string; clothing: string; personality: string }
export interface LocationDraft { name: string; description: string; architecture: string; environment: string; layout: string; lighting: string; visualDetails: string }

export type Proposal =
  | { kind: "text"; title: string; body: string }
  | { kind: "logline"; options: string[] }
  | { kind: "script"; title: string; content: string; replaceScriptId: ID | null }
  | { kind: "scenes"; scriptId: ID | null; scenes: SceneDraft[] }
  | { kind: "scene_update"; sceneId: ID; patch: { heading?: string; title?: string; description?: string; dialogue?: string } }
  | { kind: "shots"; sceneId: ID | null; shots: ShotDraft[] }
  | { kind: "characters"; characters: CharacterDraft[] }
  | { kind: "locations"; locations: LocationDraft[] };

/* ------------------------------------------------------------- validation */

type R = Record<string, unknown>;
const obj = (v: unknown): R => (v && typeof v === "object" && !Array.isArray(v) ? (v as R) : {});
const s = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");
const list = (v: unknown): R[] => (Array.isArray(v) ? v.map(obj) : []);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => s(x, 200)).filter(Boolean) : typeof v === "string" && v ? v.split(",").map(x => x.trim()).filter(Boolean) : []);
const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : parseFloat(s(v)); return isFinite(n) && n > 0 ? Math.min(n, 600) : null; };

function sceneDraft(r: R): SceneDraft {
  return { heading: s(r.heading, 300), title: s(r.title, 300), description: s(r.description), dialogue: s(r.dialogue), characterNames: names(r.characters ?? r.characterNames), locationName: s(r.location ?? r.locationName, 200) };
}
function shotDraft(r: R): ShotDraft {
  return {
    title: s(r.title, 300), description: s(r.description), framing: s(r.framing, 200), cameraAngle: s(r.cameraAngle ?? r.camera_angle, 200),
    cameraMovement: s(r.cameraMovement ?? r.camera_movement, 200), lighting: s(r.lighting, 500), mood: s(r.mood, 300),
    durationSec: num(r.durationSec ?? r.duration), characterNames: names(r.characters ?? r.characterNames), locationName: s(r.location ?? r.locationName, 200),
  };
}

/** Coerce untrusted model output into a Proposal, or null if unusable. */
export function normalizeProposal(raw: unknown, project: Project): Proposal | null {
  const r = obj(raw);
  const kind = s(r.kind ?? r.type);
  const sceneIds = new Set(project.scenes.map(x => x.id));
  const scriptIds = new Set(project.scripts.map(x => x.id));
  switch (kind) {
    case "text": { const body = s(r.body ?? r.content); return body ? { kind, title: s(r.title, 300) || "Suggestion", body } : null; }
    case "logline": { const options = (Array.isArray(r.options) ? r.options : [r.logline]).map(x => s(x, 1000)).filter(Boolean); return options.length ? { kind, options } : null; }
    case "script": {
      const content = s(r.content);
      if (!content) return null;
      const rid = s(r.replaceScriptId);
      return { kind, title: s(r.title, 300) || "AI draft", content, replaceScriptId: scriptIds.has(rid) ? rid : null };
    }
    case "scenes": { const scenes = list(r.scenes).map(sceneDraft).filter(x => x.heading || x.title || x.description); const sid = s(r.scriptId); return scenes.length ? { kind, scriptId: scriptIds.has(sid) ? sid : null, scenes } : null; }
    case "scene_update": {
      const sceneId = s(r.sceneId);
      if (!sceneIds.has(sceneId)) return null;
      const p = obj(r.patch);
      const patch: { heading?: string; title?: string; description?: string; dialogue?: string } = {};
      for (const k of ["heading", "title", "description", "dialogue"] as const) if (typeof p[k] === "string") patch[k] = s(p[k]);
      return Object.keys(patch).length ? { kind, sceneId, patch } : null;
    }
    case "shots": { const shots = list(r.shots).map(shotDraft).filter(x => x.title || x.description); const sid = s(r.sceneId); return shots.length ? { kind, sceneId: sceneIds.has(sid) ? sid : null, shots } : null; }
    case "characters": {
      const characters = list(r.characters).map(c => ({ name: s(c.name, 200), description: s(c.description), appearance: s(c.appearance), clothing: s(c.clothing), personality: s(c.personality) })).filter(c => c.name);
      return characters.length ? { kind, characters } : null;
    }
    case "locations": {
      const locations = list(r.locations).map(l => ({ name: s(l.name, 200), description: s(l.description), architecture: s(l.architecture), environment: s(l.environment), layout: s(l.layout), lighting: s(l.lighting), visualDetails: s(l.visualDetails ?? l.details) })).filter(l => l.name);
      return locations.length ? { kind, locations } : null;
    }
    default: return null;
  }
}

export function normalizeProposals(raw: unknown, project: Project): Proposal[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray(obj(raw).proposals) ? (obj(raw).proposals as unknown[]) : [];
  return arr.map(p => normalizeProposal(p, project)).filter((p): p is Proposal => !!p).slice(0, 10);
}

/** Extract JSON from model text that may be wrapped in ``` fences or prose. */
export function parseJsonLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

/** Chat replies may embed proposals in a ```wonderboy … ``` block. Returns visible text + proposals. */
export function splitChatReply(text: string, project: Project): { text: string; proposals: Proposal[] } {
  const re = /```wonderboy\s*([\s\S]*?)```/gi;
  const proposals: Proposal[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) proposals.push(...normalizeProposals(parseJsonLoose(m[1]), project));
  return { text: text.replace(re, "").trim(), proposals };
}

/* ---------------------------------------------------------------- applying */

function matchIds<T extends { id: ID; name: string }>(items: T[], wanted: string[]): { ids: ID[]; missing: string[] } {
  const ids: ID[] = [], missing: string[] = [];
  for (const n of wanted) {
    const hit = items.find(i => i.name.trim().toLowerCase() === n.trim().toLowerCase());
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else missing.push(n);
  }
  return { ids, missing };
}

export interface ApplyOptions {
  /** Only for script proposals with replaceScriptId: overwrite after explicit user confirmation. */
  replace?: boolean;
  /** Target for scenes/shots when the proposal has none. */
  scriptId?: ID | null;
  sceneId?: ID | null;
}

/** Applies a proposal to the draft. Returns a human summary for the activity log. Never deletes anything. */
export function applyProposal(d: Project, p: Proposal, opts: ApplyOptions = {}): string {
  const note = (missing: string[]) => (missing.length ? ` (not found in libraries: ${[...new Set(missing)].join(", ")})` : "");
  switch (p.kind) {
    case "text":
      d.scripts.push(makeScript({ title: p.title, content: p.body }));
      return `Saved AI notes “${p.title}” as a new script`;
    case "logline":
      d.logline = p.options[0];
      return "Updated logline from AI suggestion";
    case "script": {
      const target = p.replaceScriptId ? d.scripts.find(x => x.id === p.replaceScriptId) : undefined;
      if (target && opts.replace) {
        target.content = p.content;
        target.updatedAt = nowIso();
        return `Replaced script “${target.title}” with AI version`;
      }
      d.scripts.push(makeScript({ title: p.title, content: p.content }));
      return `Added AI script “${p.title}”`;
    }
    case "scenes": {
      const scriptId = [p.scriptId, opts.scriptId, d.scripts[0]?.id].find(id => id && d.scripts.some(x => x.id === id));
      if (!scriptId) return "No script to add scenes to";
      const missing: string[] = [];
      for (const sd of p.scenes) {
        const ch = matchIds(d.characters, sd.characterNames);
        const loc = sd.locationName ? matchIds(d.locations, [sd.locationName]) : { ids: [], missing: [] };
        missing.push(...ch.missing, ...loc.missing);
        d.scenes.push(makeScene(scriptId, { heading: sd.heading, title: sd.title, description: sd.description, dialogue: sd.dialogue, characterIds: ch.ids, locationId: loc.ids[0] ?? null }));
      }
      const script = d.scripts.find(x => x.id === scriptId)!;
      return `Added ${p.scenes.length} AI scene${p.scenes.length === 1 ? "" : "s"} to “${script.title}” (now ${scenesOf(d, scriptId).length})${note(missing)}`;
    }
    case "scene_update": {
      const scene = d.scenes.find(x => x.id === p.sceneId);
      if (!scene) return "Scene no longer exists";
      Object.assign(scene, p.patch, { updatedAt: nowIso() });
      return `Updated scene “${scene.heading || scene.title}” from AI suggestion`;
    }
    case "shots": {
      const sceneId = [p.sceneId, opts.sceneId].find(id => id && d.scenes.some(x => x.id === id)) ?? null;
      const scene = d.scenes.find(x => x.id === sceneId);
      const missing: string[] = [];
      for (const sd of p.shots) {
        const ch = matchIds(d.characters, sd.characterNames.length ? sd.characterNames : []);
        const loc = sd.locationName ? matchIds(d.locations, [sd.locationName]) : { ids: [], missing: [] };
        missing.push(...ch.missing, ...loc.missing);
        const characters: ShotCharacterRef[] = (ch.ids.length ? ch.ids : scene?.characterIds ?? []).map(characterId => ({ characterId, variationId: null }));
        d.shots.push(makeShot({
          sceneId, title: sd.title, description: sd.description, framing: sd.framing, cameraAngle: sd.cameraAngle, cameraMovement: sd.cameraMovement,
          lighting: sd.lighting, mood: sd.mood, durationSec: sd.durationSec, characters, locationId: loc.ids[0] ?? scene?.locationId ?? null,
        }));
      }
      return `Added ${p.shots.length} AI shot${p.shots.length === 1 ? "" : "s"}${scene ? ` to “${scene.heading || scene.title}”` : " (unassigned)"}${note(missing)}`;
    }
    case "characters": {
      const added: string[] = [];
      for (const c of p.characters) {
        if (d.characters.some(x => x.name.trim().toLowerCase() === c.name.trim().toLowerCase())) continue;
        d.characters.push(makeCharacter(c));
        added.push(c.name);
      }
      return added.length ? `Added AI characters: ${added.join(", ")}` : "All suggested characters already exist";
    }
    case "locations": {
      const added: string[] = [];
      for (const l of p.locations) {
        if (d.locations.some(x => x.name.trim().toLowerCase() === l.name.trim().toLowerCase())) continue;
        d.locations.push(makeLocation(l));
        added.push(l.name);
      }
      return added.length ? `Added AI locations: ${added.join(", ")}` : "All suggested locations already exist";
    }
  }
}

/** JSON schema-ish description given to the model so its output matches normalizeProposal. */
export const PROPOSAL_FORMAT = `Proposal objects (use only the fields shown; IDs must be copied exactly from the project context):
{"kind":"text","title":string,"body":string}                       // ideas, outlines, notes
{"kind":"logline","options":[string, ...]}                          // 1-5 logline options
{"kind":"script","title":string,"content":string,"replaceScriptId":string|null}  // full screenplay text; replaceScriptId only when improving an existing script
{"kind":"scenes","scriptId":string|null,"scenes":[{"heading":"INT. ... - DAY","title":string,"description":string,"dialogue":string,"characters":[names],"location":name}]}
{"kind":"scene_update","sceneId":string,"patch":{"heading"?:string,"title"?:string,"description"?:string,"dialogue"?:string}}
{"kind":"shots","sceneId":string|null,"shots":[{"title":string,"description":string,"framing":string,"cameraAngle":string,"cameraMovement":string,"lighting":string,"mood":string,"durationSec":number,"characters":[names],"location":name}]}
{"kind":"characters","characters":[{"name","description","appearance","clothing","personality"}]}
{"kind":"locations","locations":[{"name","description","architecture","environment","layout","lighting","visualDetails"}]}`;
