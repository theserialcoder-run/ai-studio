// Domain model for a Wonderboy project. One Project document holds everything
// that belongs to a film. Uploaded files live on disk next to the document and
// are referenced from records by asset ID (see src/lib/server/storage.ts).

export const SCHEMA_VERSION = 1;

export type ID = string;

export type AssetKind = "image" | "video" | "audio" | "document" | "other";

export interface Asset {
  id: ID;
  name: string; // original / display file name
  kind: AssetKind;
  mimeType: string;
  size: number; // bytes
  fileName: string; // stored file name inside the project's files/ folder
  tags: string[];
  notes: string;
  createdAt: string;
}

export interface Script {
  id: ID;
  title: string;
  content: string; // full screenplay text
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: ID;
  scriptId: ID;
  heading: string; // slugline, e.g. "INT. KITCHEN - NIGHT"
  title: string;
  description: string;
  dialogue: string; // dialogue & action text for the scene
  characterIds: ID[];
  locationId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type ShotStatus = "Planning" | "Ready" | "In progress" | "Done";
export const SHOT_STATUSES: ShotStatus[] = ["Planning", "Ready", "In progress", "Done"];

/** A character appearing in a shot, optionally in a specific wardrobe/appearance variation. */
export interface ShotCharacterRef {
  characterId: ID;
  variationId: ID | null;
}

export interface Shot {
  id: ID;
  sceneId: ID | null; // null = unassigned
  title: string;
  description: string;
  cameraAngle: string;
  cameraMovement: string;
  framing: string;
  lighting: string;
  mood: string;
  durationSec: number | null;
  status: ShotStatus;
  notes: string;
  characters: ShotCharacterRef[];
  locationId: ID | null;
  locationAngleId: ID | null;
  assetIds: ID[]; // extra reference assets (storyboard frames, props, mood images…)
  generatedAssetIds: ID[]; // AI-generated images/videos ("takes") for this shot
  createdAt: string;
  updatedAt: string;
}

/** Wardrobe / appearance variation. Identity fields stay on the Character. */
export interface CharacterVariation {
  id: ID;
  name: string;
  description: string;
  assetIds: ID[];
}

export interface Character {
  id: ID;
  name: string;
  description: string;
  appearance: string; // canonical physical appearance (identity)
  clothing: string; // default wardrobe
  personality: string;
  notes: string;
  referenceAssetIds: ID[]; // canonical identity references
  primaryAssetId: ID | null;
  variations: CharacterVariation[];
  createdAt: string;
  updatedAt: string;
}

/** A camera angle / view of a location. */
export interface LocationAngle {
  id: ID;
  name: string;
  description: string;
  assetIds: ID[];
}

export interface Location {
  id: ID;
  name: string;
  description: string;
  architecture: string;
  environment: string;
  layout: string;
  lighting: string;
  visualDetails: string; // fixed details that must not change
  referenceAssetIds: ID[];
  primaryAssetId: ID | null;
  angles: LocationAngle[];
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  id: ID;
  at: string;
  message: string;
}

export interface Project {
  schemaVersion: number;
  id: ID;
  name: string;
  logline: string;
  style: string; // style bible
  revision: number; // incremented by the server on every save
  createdAt: string;
  updatedAt: string;
  scripts: Script[];
  scenes: Scene[]; // array order = scene order within each script
  shots: Shot[]; // array order = shot order within each scene
  characters: Character[];
  locations: Location[];
  assets: Asset[];
  activity: ActivityEntry[]; // newest first
  /** Generation jobs whose outputs were already added to `assets` (prevents re-import after deletion). */
  importedGenerationIds: ID[];
}

export interface ProjectSummary {
  id: ID;
  name: string;
  logline: string;
  updatedAt: string;
  createdAt: string;
  counts: { scripts: number; scenes: number; shots: number; characters: number; locations: number; assets: number };
}
