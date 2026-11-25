"use client";
import type { ID, ShotCharacterRef } from "@/lib/types";
import { useStudio } from "./studio";

export interface ContinuityValue {
  characters: ShotCharacterRef[];
  locationId: ID | null;
  locationAngleId: ID | null;
}

/** Choose characters (with an optional wardrobe variation) and a location (with an optional camera angle). */
export function ContinuityPicker({ value, onChange }: { value: ContinuityValue; onChange: (patch: Partial<ContinuityValue>) => void }) {
  const { project, go } = useStudio();
  const location = project.locations.find(l => l.id === value.locationId);

  return (
    <div className="continuity-picker">
      <div>
        <span className="field-label">CHARACTERS</span>
        {project.characters.length === 0 && <p className="muted small">No characters yet. <button className="text-button" onClick={() => go("Characters")}>Add characters ↗</button></p>}
        <div className="stack tight">
          {project.characters.map(c => {
            const ref = value.characters.find(r => r.characterId === c.id);
            return (
              <div key={c.id} className={`pick-row${ref ? " on" : ""}`}>
                <label className="check">
                  <input type="checkbox" checked={!!ref} onChange={e => onChange({
                    characters: e.target.checked ? [...value.characters, { characterId: c.id, variationId: null }] : value.characters.filter(r => r.characterId !== c.id),
                  })} />
                  <span>{c.name}<small>{c.referenceAssetIds.length} ref image{c.referenceAssetIds.length === 1 ? "" : "s"}</small></span>
                </label>
                {ref && c.variations.length > 0 && (
                  <select className="field compact" aria-label={`${c.name} wardrobe`} value={ref.variationId ?? ""}
                    onChange={e => onChange({ characters: value.characters.map(r => (r.characterId === c.id ? { ...r, variationId: e.target.value || null } : r)) })}>
                    <option value="">Default wardrobe</option>
                    {c.variations.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="form-grid">
        <label>LOCATION
          <select className="field" value={value.locationId ?? ""} onChange={e => onChange({ locationId: e.target.value || null, locationAngleId: null })}>
            <option value="">— None —</option>
            {project.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>CAMERA ANGLE OF LOCATION
          <select className="field" value={value.locationAngleId ?? ""} disabled={!location || location.angles.length === 0}
            onChange={e => onChange({ locationAngleId: e.target.value || null })}>
            <option value="">{location && location.angles.length ? "Any / master view" : "No saved angles"}</option>
            {location?.angles.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
