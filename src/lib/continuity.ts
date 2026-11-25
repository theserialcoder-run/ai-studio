// Builds the structured continuity payload that image/video generation adapters
// will receive. Nothing here generates media, and nothing guarantees visual
// consistency: it only collects the canonical records and reference images a
// reference-conditioned provider would need.
import { assetById, fileUrl, shotNumber } from "./projectModel";
import type { Asset, ID, Project, ShotCharacterRef } from "./types";

export type ReferenceRole = "identity" | "wardrobe" | "location" | "location-angle" | "shot";

export interface ReferenceImage {
  assetId: ID;
  name: string;
  mimeType: string;
  url: string; // same-origin URL served by /api/projects/[id]/files/[assetId]
  role: ReferenceRole;
  primary: boolean;
}

export interface CharacterReference {
  characterId: ID;
  name: string;
  description: string;
  appearance: string;
  personality: string;
  wardrobe: { variationId: ID | null; name: string; description: string };
  referenceImages: ReferenceImage[];
}

export interface LocationReference {
  locationId: ID;
  name: string;
  description: string;
  architecture: string;
  environment: string;
  layout: string;
  lighting: string;
  visualDetails: string;
  angle: { angleId: ID; name: string; description: string } | null;
  referenceImages: ReferenceImage[];
}

export interface ShotSpec {
  shotId: ID;
  number: string;
  title: string;
  description: string;
  cameraAngle: string;
  cameraMovement: string;
  framing: string;
  lighting: string;
  mood: string;
  durationSec: number | null;
}

/** The normalized request body generation adapters should accept. */
export interface ContinuityBundle {
  version: 1;
  projectId: ID;
  style: string;
  shot: ShotSpec | null;
  characters: CharacterReference[];
  location: LocationReference | null;
  additionalReferences: ReferenceImage[];
}

export interface ContinuitySelection {
  shotId?: ID | null;
  /** Used when no shot is selected. */
  characters?: ShotCharacterRef[];
  locationId?: ID | null;
  locationAngleId?: ID | null;
}

function ref(project: Project, asset: Asset | undefined, role: ReferenceRole, primaryId: ID | null = null): ReferenceImage[] {
  if (!asset || asset.kind !== "image") return [];
  return [{ assetId: asset.id, name: asset.name, mimeType: asset.mimeType, url: fileUrl(project.id, asset.id), role, primary: asset.id === primaryId }];
}

export function buildContinuityBundle(project: Project, sel: ContinuitySelection): ContinuityBundle {
  const shot = sel.shotId ? project.shots.find(s => s.id === sel.shotId) ?? null : null;
  const charRefs = shot ? shot.characters : sel.characters ?? [];
  const locationId = shot ? shot.locationId : sel.locationId ?? null;
  const angleId = shot ? shot.locationAngleId : sel.locationAngleId ?? null;

  const characters: CharacterReference[] = charRefs.flatMap(cr => {
    const c = project.characters.find(x => x.id === cr.characterId);
    if (!c) return [];
    const variation = cr.variationId ? c.variations.find(v => v.id === cr.variationId) : undefined;
    const primaryFirst = c.primaryAssetId ? [c.primaryAssetId, ...c.referenceAssetIds.filter(a => a !== c.primaryAssetId)] : c.referenceAssetIds;
    return [{
      characterId: c.id, name: c.name, description: c.description, appearance: c.appearance, personality: c.personality,
      wardrobe: variation
        ? { variationId: variation.id, name: variation.name, description: variation.description }
        : { variationId: null, name: "Default", description: c.clothing },
      referenceImages: [
        ...primaryFirst.flatMap(a => ref(project, assetById(project, a), "identity", c.primaryAssetId)),
        ...(variation?.assetIds ?? []).flatMap(a => ref(project, assetById(project, a), "wardrobe")),
      ],
    }];
  });

  const loc = locationId ? project.locations.find(l => l.id === locationId) : undefined;
  const angle = loc && angleId ? loc.angles.find(a => a.id === angleId) : undefined;
  const location: LocationReference | null = loc ? {
    locationId: loc.id, name: loc.name, description: loc.description, architecture: loc.architecture, environment: loc.environment,
    layout: loc.layout, lighting: loc.lighting, visualDetails: loc.visualDetails,
    angle: angle ? { angleId: angle.id, name: angle.name, description: angle.description } : null,
    referenceImages: [
      ...(angle?.assetIds ?? []).flatMap(a => ref(project, assetById(project, a), "location-angle")),
      ...loc.referenceAssetIds.flatMap(a => ref(project, assetById(project, a), "location", loc.primaryAssetId)),
    ],
  } : null;

  return {
    version: 1,
    projectId: project.id,
    style: project.style,
    shot: shot ? {
      shotId: shot.id, number: shotNumber(project, shot), title: shot.title, description: shot.description,
      cameraAngle: shot.cameraAngle, cameraMovement: shot.cameraMovement, framing: shot.framing,
      lighting: shot.lighting, mood: shot.mood, durationSec: shot.durationSec,
    } : null,
    characters,
    location,
    additionalReferences: shot ? shot.assetIds.flatMap(a => ref(project, assetById(project, a), "shot")) : [],
  };
}

const line = (label: string, value: string | null | undefined) => (value && value.trim() ? `${label}: ${value.trim()}` : null);

/** Human-readable prompt text. Text alone does not keep characters consistent. */
export function continuityPrompt(bundle: ContinuityBundle, userPrompt: string): string {
  const parts: string[] = [];
  if (bundle.style.trim()) parts.push(`STYLE:\n${bundle.style.trim()}`);
  if (bundle.shot) {
    const s = bundle.shot;
    parts.push(["SHOT " + s.number + (s.title ? ` — ${s.title}` : ""), s.description, line("Framing", s.framing), line("Camera angle", s.cameraAngle),
      line("Camera movement", s.cameraMovement), line("Lighting", s.lighting), line("Mood", s.mood),
      s.durationSec ? `Duration: ${s.durationSec}s` : null].filter(Boolean).join("\n"));
  }
  for (const c of bundle.characters) {
    parts.push([`CHARACTER ${c.name}`, c.description, line("Appearance (keep identical)", c.appearance),
      line(`Wardrobe (${c.wardrobe.name})`, c.wardrobe.description), `Reference images: ${c.referenceImages.length}`].filter(Boolean).join("\n"));
  }
  if (bundle.location) {
    const l = bundle.location;
    parts.push([`LOCATION ${l.name}${l.angle ? ` — ${l.angle.name}` : ""}`, l.description, line("Architecture", l.architecture),
      line("Environment", l.environment), line("Layout", l.layout), line("Lighting", l.lighting),
      line("Fixed visual details", l.visualDetails), line("Camera angle", l.angle?.description), `Reference images: ${l.referenceImages.length}`].filter(Boolean).join("\n"));
  }
  if (userPrompt.trim()) parts.push(`PROMPT:\n${userPrompt.trim()}`);
  return parts.join("\n\n");
}

export function referenceImageCount(bundle: ContinuityBundle): number {
  return bundle.characters.reduce((n, c) => n + c.referenceImages.length, 0)
    + (bundle.location?.referenceImages.length ?? 0) + bundle.additionalReferences.length;
}
