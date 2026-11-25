import type { ContinuityBundle } from "../continuity";

/** Summarizes a continuity bundle received by a placeholder generation route. */
export function describeReferences(body: unknown): string {
  const c = (body as { continuity?: Partial<ContinuityBundle> } | null)?.continuity;
  if (!c || typeof c !== "object") return "No continuity references were attached.";
  const chars = Array.isArray(c.characters) ? c.characters : [];
  const images = chars.reduce((n, ch) => n + (Array.isArray(ch?.referenceImages) ? ch.referenceImages.length : 0), 0)
    + (Array.isArray(c.location?.referenceImages) ? c.location.referenceImages.length : 0)
    + (Array.isArray(c.additionalReferences) ? c.additionalReferences.length : 0);
  return `Received ${chars.length} character reference(s), ${c.location ? "1 location" : "no location"} and ${images} reference image(s).`;
}
