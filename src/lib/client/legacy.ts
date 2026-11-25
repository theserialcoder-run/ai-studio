// One-time import of the pre-server single-project format that lived in
// localStorage["wonderboy-studio-project-v1"]. The original browser data is
// left in place (not deleted) as a fallback.
import { api } from "./api";
import { logActivity, makeCharacter, makeLocation, makeScene, makeShot } from "../projectModel";
import { SHOT_STATUSES, type Project, type Scene, type ShotStatus } from "../types";

export const LEGACY_KEY = "wonderboy-studio-project-v1";
const MIGRATED_KEY = "wonderboy-legacy-migrated";

type LegacyAsset = { id?: string; name?: string; kind?: string; description?: string; image?: string };
type LegacyShot = { title?: string; scene?: string; description?: string; characterIds?: string[]; locationId?: string; status?: string };
type Legacy = { name?: string; logline?: string; style?: string; script?: string; assets?: LegacyAsset[]; shots?: LegacyShot[] };

const s = (v: unknown) => (typeof v === "string" ? v : "");

function readLegacy(): Legacy | null {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return null;
    const raw = localStorage.getItem(LEGACY_KEY);
    return raw ? (JSON.parse(raw) as Legacy) : null;
  } catch {
    return null;
  }
}

/** Returns the imported project, or null if there was nothing to import. */
export async function migrateLegacyProject(): Promise<Project | null> {
  const legacy = readLegacy();
  if (!legacy) return null;

  const created = await api.create({ name: s(legacy.name) || "Imported film", logline: s(legacy.logline), style: s(legacy.style) || undefined });
  const draft = structuredClone(created);
  const script = draft.scripts[0];
  script.content = s(legacy.script);

  for (const a of legacy.assets ?? []) {
    const assetIds: string[] = [];
    if (s(a.image).startsWith("data:")) {
      try {
        const blob = await (await fetch(a.image!)).blob();
        const ext = (blob.type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5);
        const [asset] = await api.upload(draft.id, [blob], [`${s(a.name) || "reference"}.${ext}`]);
        draft.assets.push(asset);
        assetIds.push(asset.id);
      } catch {
        /* keep the record without the image */
      }
    }
    const base = { ...(a.id ? { id: a.id } : {}), name: s(a.name) || "Unnamed", description: s(a.description), referenceAssetIds: assetIds, primaryAssetId: assetIds[0] ?? null };
    if (a.kind === "location") draft.locations.push(makeLocation(base));
    else draft.characters.push(makeCharacter(base));
  }

  const scenes = new Map<string, Scene>();
  for (const shot of legacy.shots ?? []) {
    const label = s(shot.scene) || "Scene 01";
    let scene = scenes.get(label);
    if (!scene) {
      scene = makeScene(script.id, { title: label });
      scenes.set(label, scene);
      draft.scenes.push(scene);
    }
    draft.shots.push(makeShot({
      sceneId: scene.id, title: s(shot.title), description: s(shot.description),
      status: SHOT_STATUSES.includes(shot.status as ShotStatus) ? (shot.status as ShotStatus) : "Planning",
      characters: (shot.characterIds ?? []).map(characterId => ({ characterId, variationId: null })),
      locationId: s(shot.locationId) || null,
    }));
  }

  logActivity(draft, "Imported project saved in this browser by an earlier version");
  await api.save(draft, created.revision);
  try { localStorage.setItem(MIGRATED_KEY, new Date().toISOString()); } catch { /* ignore */ }
  return api.get(draft.id);
}
