// PURE helpers for Story Cuts, shared by the browser and the server.
import type { Asset, ID, StoryCastMember, StoryCutLine, StoryCutSegment } from "./types";

export interface StoryStyle { id: string; label: string; footage: string; prompt: string }

/** Story presets. `footage` hints which free footage suits them. */
export const STORY_STYLES: StoryStyle[] = [
  { id: "life-lesson", label: "Life lesson", footage: "Stock or classics",
    prompt: "A heartfelt, grounded story with a clear life lesson, told in third person by a calm, warm narrator. It ends with a quiet, memorable moral." },
  { id: "stranger", label: "A stranger changed my life", footage: "Modern stock footage",
    prompt: "A first-person, true-story-feeling (but fictional) account of an unexpected encounter with a stranger that changed the narrator's life. Emotional, specific details, a turn in the middle, a touching ending." },
  { id: "love", label: "Love story", footage: "Stock or classics",
    prompt: "A tender love story with longing, a misunderstanding or obstacle, and a bittersweet or hopeful ending. Third person, intimate tone." },
  { id: "confession", label: "Confession", footage: "Modern stock footage",
    prompt: "A first-person confession in the style of an anonymous online story: \"I never told anyone this…\". Present day, conversational, builds tension, ends with a twist or reveal." },
  { id: "noir", label: "Noir crime", footage: "Black-and-white classics",
    prompt: "A hard-boiled film-noir crime story narrated in first person by a weary narrator: rain, bad decisions, betrayal, and a twist at the end. Short punchy sentences." },
  { id: "eerie", label: "Eerie tale", footage: "Classic horror / night footage",
    prompt: "A slow-building, unsettling tale told like a campfire story. Suggest rather than show; no gore. End with a chilling twist." },
  { id: "fable", label: "Fable", footage: "Silent films / classics",
    prompt: "A timeless fable told by an old storyteller (\"Long ago…\"), simple and rhythmic, with a clear moral at the end." },
  { id: "custom", label: "Custom (use my instructions)", footage: "Any", prompt: "" },
];

export const styleById = (id: string) => STORY_STYLES.find(s => s.id === id) ?? STORY_STYLES[0];

/** Narration words that fit comfortably in `seconds` at a voice speed (Kokoro ≈ 2.5 words/s at 1×). */
export function wordBudget(seconds: number, speed = 1): number {
  return Math.max(0, Math.floor(seconds * 2.4 * speed));
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export const segmentLength = (s: Pick<StoryCutSegment, "start" | "end">) => Math.max(0, s.end - s.start);

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------- jobs */

/** "auto" = script mode in one go: detect (if needed) → describe → cast (if empty) → match. */
export type StoryJobKind = "detect" | "describe" | "render" | "auto" | "stock";

export interface StoryJob {
  id: ID;
  kind: StoryJobKind;
  cutId: ID;
  cutTitle: string;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  notes: string;
  createdAt: string;
  finishedAt: string | null;
  /** detect: the new scene list (replaces the cut's segments). */
  segments?: StoryCutSegment[];
  /** describe: segment id → description (also kept on failure, for partial results). */
  descriptions?: Record<ID, string>;
  /** render: the finished video. */
  output?: Asset;
  /** auto: the suggested cast (only when the cut had none). */
  cast?: StoryCastMember[];
  /** auto / stock: the script timeline. */
  lines?: StoryCutLine[];
  /** stock: downloaded clips to add to the asset library (their segments are in `segments`). */
  assets?: Asset[];
}

export type StoryJobView = StoryJob & { progress: string | null };

export interface StoryDraft {
  title: string;
  summary: string;
  narrations: Record<ID, string>;
  skips: ID[];
}
