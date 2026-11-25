// AI types shared by the server (providers, jobs) and the browser (UI).
// No secrets and no Node/browser APIs in this file.
import type { Asset, ID } from "../types";

export type Billing = "free-allocation" | "paid";

export interface ImageCaps {
  /** Max reference images the model can be conditioned on. 0 = text-only model. */
  maxReferences: number;
  /** Accepts a source image to edit/transform (image-to-image). */
  imageToImage: boolean;
  aspectRatios: string[];
  sizes: string[]; // e.g. ["1K","2K","4K"]; empty = fixed
  steps: { min: number; max: number; default: number } | null;
  seed: boolean;
  guidance: boolean;
  negativePrompt: boolean;
  /** References are downscaled in the browser so their longest side is <= this. */
  referenceMaxSide: number;
}

export interface VideoCaps {
  textToVideo: boolean;
  imageToVideo: boolean;
  maxReferences: number; // reference images (subject/style), 0 = none
  durations: number[]; // allowed seconds
  aspectRatios: string[]; // empty = follows the start image
  resolutions: string[];
  negativePrompt: boolean;
  /** USD per second by resolution (or "default"), for the cost estimate. Null = see provider pricing. */
  costPerSecond: Record<string, number> | null;
  imageMaxSide: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  vendor: string;
  model: string;
  configured: boolean;
  billing: Billing;
  costNote: string;
  /** Env variables that must be set. */
  requirements: string[];
  setup: string;
  conditioning: string; // honest description of how references are used
}

export interface ImageProviderInfo extends ProviderInfo { kind: "image"; caps: ImageCaps }
export interface VideoProviderInfo extends ProviderInfo { kind: "video"; caps: VideoCaps }
export interface LlmProviderInfo extends ProviderInfo { kind: "llm" }

export interface ProvidersResponse {
  llm: LlmProviderInfo[];
  activeLlm: string | null;
  image: ImageProviderInfo[];
  video: VideoProviderInfo[];
}

/** A reference image sent from the browser (already downscaled). */
export interface ReferenceInput {
  assetId: ID;
  role: "character" | "wardrobe" | "location" | "location-angle" | "shot" | "source" | "start-frame" | "other";
  label: string; // e.g. “Ramesh — identity”
  mimeType: string;
  data: string; // base64 without data: prefix
}

export interface ImageSettings {
  aspectRatio: string;
  size?: string;
  steps?: number;
  seed?: number;
  guidance?: number;
  count?: number;
}

export interface VideoSettings {
  aspectRatio?: string;
  durationSec: number;
  resolution?: string;
  generateAudio?: boolean;
}

export interface GenerationRequest {
  type: "image" | "video";
  providerId: string;
  prompt: string;
  negativePrompt?: string;
  imageSettings?: ImageSettings;
  videoSettings?: VideoSettings;
  references: ReferenceInput[];
  /** Image-to-image source, or the start frame for image-to-video. */
  sourceImage?: ReferenceInput | null;
  shotId?: ID | null;
  /** Must be true for paid providers — the user explicitly approved the cost. */
  approvedPaid?: boolean;
}

export type GenerationStatus = "running" | "succeeded" | "failed";

/** Persisted record of one generation job (data/projects/<id>/generations.json). */
export interface GenerationRecord {
  id: ID;
  type: "image" | "video";
  providerId: string;
  providerLabel: string;
  model: string;
  status: GenerationStatus;
  error: string | null;
  prompt: string;
  negativePrompt: string;
  imageSettings: ImageSettings | null;
  videoSettings: VideoSettings | null;
  references: { assetId: ID; role: string; label: string }[];
  sourceAssetId: ID | null;
  shotId: ID | null;
  outputs: Asset[];
  notes: string; // text returned by the model, warnings
  costEstimate: string;
  createdAt: string;
  finishedAt: string | null;
}

/* ------------------------------------------------------------- conversations */

export interface StoredMessage {
  id: ID;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Conversation {
  id: ID;
  title: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
}
