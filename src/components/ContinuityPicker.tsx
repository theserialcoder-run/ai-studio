"use client";
import type { ID, ShotCharacterRef } from "@/lib/types";
import { Dropdown } from "./Dropdown";
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
                  <Dropdown compact ariaLabel={`${c.name} wardrobe`} value={ref.variationId ?? ""}
                    onChange={v => onChange({ characters: value.characters.map(r => (r.characterId === c.id ? { ...r, variationId: v || null } : r)) })}
                    options={[{ value: "", label: "Default wardrobe" }, ...c.variations.map(v => ({ value: v.id, label: v.name }))]} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="form-grid">
        <label>LOCATION
          <Dropdown value={value.locationId ?? ""} onChange={v => onChange({ locationId: v || null, locationAngleId: null })}
            options={[{ value: "", label: "— None —" }, ...project.locations.map(l => ({ value: l.id, label: l.name }))]} />
        </label>
        <label>CAMERA ANGLE OF LOCATION
          <Dropdown value={value.locationAngleId ?? ""} disabled={!location || location.angles.length === 0}
            onChange={v => onChange({ locationAngleId: v || null })}
            options={[{ value: "", label: location && location.angles.length ? "Any / master view" : "No saved angles" }, ...(location?.angles ?? []).map(a => ({ value: a.id, label: a.name }))]} />
        </label>
      </div>
    </div>
  );
}
