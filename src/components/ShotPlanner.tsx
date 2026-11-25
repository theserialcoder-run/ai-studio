"use client";
import { useEffect, useState } from "react";
import { assetById, makeShot, moveWithinGroup, newId, nowIso, sceneLabel, scenesOf, shotNumber, shotsOf } from "@/lib/projectModel";
import { SHOT_STATUSES, type ID, type Project, type Shot, type ShotStatus } from "@/lib/types";
import { ContinuityPicker } from "./ContinuityPicker";
import { AssetPreview, EmptyState, ReferenceImages, RowActions, SuggestField, TextField, useStudio } from "./studio";

const FRAMINGS = ["Extreme wide shot", "Wide shot", "Full shot", "Medium wide shot", "Medium shot", "Medium close-up", "Close-up", "Extreme close-up", "Over-the-shoulder", "Two shot", "Insert"];
const ANGLES = ["Eye level", "Low angle", "High angle", "Bird's-eye view", "Worm's-eye view", "Dutch angle", "Overhead", "POV"];
const MOVEMENTS = ["Static", "Pan left", "Pan right", "Tilt up", "Tilt down", "Slow push in", "Pull out", "Dolly", "Tracking", "Handheld", "Crane up", "Crane down", "Zoom in", "Zoom out", "Orbit"];

const UNASSIGNED = "__unassigned__";

export function ShotPlanner() {
  const { ws, project, focusSceneId, setFocusSceneId } = useStudio();
  const defaultScene = focusSceneId ?? project.scenes[0]?.id ?? UNASSIGNED;
  const [sceneKey, setSceneKey] = useState<string>(defaultScene);
  const [editing, setEditing] = useState<ID | null>(null);

  // Consume a focus request from the script studio.
  useEffect(() => {
    if (focusSceneId) { setSceneKey(focusSceneId); setFocusSceneId(null); }
  }, [focusSceneId, setFocusSceneId]);

  // Falls back to the first scene if the selected one was deleted.
  const scene = sceneKey === UNASSIGNED ? undefined : (project.scenes.find(s => s.id === sceneKey) ?? project.scenes[0]);
  const shots = shotsOf(project, scene ? scene.id : null);
  const unassignedCount = shotsOf(project, null).length;

  function addShot() {
    const shot = makeShot({
      sceneId: scene?.id ?? null,
      title: `Shot ${shots.length + 1}`,
      characters: (scene?.characterIds ?? []).map(characterId => ({ characterId, variationId: null })),
      locationId: scene?.locationId ?? null,
    });
    ws.mutate(d => { d.shots.push(shot); }, `Added a shot to ${scene ? sceneLabel(project, scene) : "unassigned shots"}`);
    setEditing(shot.id);
  }

  return (
    <div className="content">
      <div className="section-head">
        <div><span className="eyebrow">VISUAL BREAKDOWN</span><h3>Scene &amp; shot planner</h3><p>Break each scene into shots with camera, lighting and continuity references.</p></div>
      </div>

      <div className="panel toolbar">
        <label className="grow">SCENE
          <select className="field" value={scene ? scene.id : UNASSIGNED} onChange={e => { setSceneKey(e.target.value); setEditing(null); }}>
            {project.scripts.map(script => {
              const list = scenesOf(project, script.id);
              return list.length ? (
                <optgroup key={script.id} label={script.title || "Untitled script"}>
                  {list.map(s => <option key={s.id} value={s.id}>{sceneLabel(project, s)} ({shotsOf(project, s.id).length})</option>)}
                </optgroup>
              ) : null;
            })}
            <option value={UNASSIGNED}>Unassigned shots ({unassignedCount})</option>
          </select>
        </label>
        <button className="button primary" onClick={addShot}>Add shot +</button>
      </div>

      {scene && (scene.description || scene.locationId || scene.characterIds.length > 0) && (
        <div className="scene-brief">
          {scene.description && <p>{scene.description}</p>}
          <div className="meta-row">
            {scene.locationId && <span>Location: {project.locations.find(l => l.id === scene.locationId)?.name}</span>}
            {scene.characterIds.length > 0 && <span>Characters: {scene.characterIds.map(id => project.characters.find(c => c.id === id)?.name).filter(Boolean).join(", ")}</span>}
          </div>
        </div>
      )}
      {project.scenes.length === 0 && <p className="muted small">Tip: create scenes in the Script studio, then plan their shots here. Shots without a scene live under “Unassigned shots”.</p>}

      <div className="shot-list">
        {shots.length === 0 && <EmptyState>No shots in this {scene ? "scene" : "list"} yet. Use “Add shot +”.</EmptyState>}
        {shots.map(shot => (
          <ShotCard key={shot.id} project={project} shot={shot} editing={editing === shot.id} onToggle={() => setEditing(editing === shot.id ? null : shot.id)} />
        ))}
      </div>
    </div>
  );
}

function ShotCard({ project, shot, editing, onToggle }: { project: Project; shot: Shot; editing: boolean; onToggle: () => void }) {
  const { ws, go, setFocusShotId } = useStudio();
  const num = shotNumber(project, shot);
  const name = `shot ${num}${shot.title ? ` “${shot.title}”` : ""}`;
  const edit = (patch: Partial<Shot>, activity = `Edited ${name}`) => ws.mutate(d => {
    const s = d.shots.find(x => x.id === shot.id);
    if (s) Object.assign(s, patch, { updatedAt: nowIso() });
  }, activity);
  const location = project.locations.find(l => l.id === shot.locationId);
  const angle = location?.angles.find(a => a.id === shot.locationAngleId);
  const sameGroup = (s: Shot) => s.sceneId === shot.sceneId;
  const thumb = assetById(project, shot.assetIds[0])
    ?? assetById(project, location?.primaryAssetId ?? location?.referenceAssetIds[0]);

  function duplicate() {
    const copy: Shot = { ...structuredClone(shot), id: newId(), title: `${shot.title || "Shot"} (copy)`, createdAt: nowIso(), updatedAt: nowIso() };
    ws.mutate(d => { d.shots.splice(d.shots.findIndex(s => s.id === shot.id) + 1, 0, copy); }, `Duplicated ${name}`);
  }

  return (
    <div className={`shot-card${editing ? " editing" : ""}`}>
      <div className="shot-summary">
        <div className="shot-number">{num}</div>
        {thumb && <div className="shot-thumb"><AssetPreview asset={thumb} /></div>}
        <div className="shot-details">
          <span className="eyebrow">{shot.status}{shot.durationSec ? ` · ${shot.durationSec}s` : ""}</span>
          <h3>{shot.title || "Untitled shot"}</h3>
          {shot.description && <p>{shot.description}</p>}
          <div className="shot-meta">
            {[shot.framing, shot.cameraAngle, shot.cameraMovement, shot.lighting, shot.mood].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}
          </div>
          <div className="chip-row">
            {shot.characters.map(ref => {
              const c = project.characters.find(x => x.id === ref.characterId);
              const v = c?.variations.find(x => x.id === ref.variationId);
              return c ? <span key={ref.characterId} className="chip static">◉ {c.name}{v ? ` · ${v.name}` : ""}</span> : null;
            })}
            {location ? <span className="chip static">⌂ {location.name}{angle ? ` · ${angle.name}` : ""}</span> : <span className="chip static warn">No location linked</span>}
            {shot.assetIds.length > 0 && <span className="chip static">▧ {shot.assetIds.length} shot refs</span>}
            {shot.generatedAssetIds.length > 0 && <span className="chip static on">✦ {shot.generatedAssetIds.length} generated take{shot.generatedAssetIds.length === 1 ? "" : "s"}</span>}
          </div>
        </div>
        <div className="shot-actions">
          <button className="button secondary" onClick={onToggle}>{editing ? "Done" : "Edit"}</button>
          <button className="text-button" onClick={() => { setFocusShotId(shot.id); go("Image Studio"); }}>Image studio ↗</button>
          <button className="text-button" onClick={() => { setFocusShotId(shot.id); go("Video Studio"); }}>Video studio ↗</button>
          <RowActions
            onUp={() => ws.mutate(d => moveWithinGroup(d.shots, shot.id, -1, sameGroup), "Reordered shots")}
            onDown={() => ws.mutate(d => moveWithinGroup(d.shots, shot.id, 1, sameGroup), "Reordered shots")}
            onDuplicate={duplicate}
            onDelete={() => { if (confirm(`Delete ${name}?`)) ws.mutate(d => { d.shots = d.shots.filter(s => s.id !== shot.id); }, `Deleted ${name}`); }}
          />
        </div>
      </div>

      {editing && (
        <div className="item-card-body">
          <div className="form-grid">
            <TextField label="TITLE" value={shot.title} onChange={v => edit({ title: v })} />
            <label>SCENE
              <select className="field" value={shot.sceneId ?? ""} onChange={e => edit({ sceneId: e.target.value || null }, `Moved ${name} to another scene`)}>
                <option value="">Unassigned</option>
                {project.scenes.map(s => <option key={s.id} value={s.id}>{sceneLabel(project, s)}</option>)}
              </select>
            </label>
          </div>
          <TextField label="DESCRIPTION / ACTION" multiline value={shot.description} onChange={v => edit({ description: v })} placeholder="What we see: subject, action, composition…" />
          <div className="form-grid three">
            <SuggestField label="FRAMING" value={shot.framing} onChange={v => edit({ framing: v })} options={FRAMINGS} placeholder="Medium close-up" />
            <SuggestField label="CAMERA ANGLE" value={shot.cameraAngle} onChange={v => edit({ cameraAngle: v })} options={ANGLES} placeholder="Eye level" />
            <SuggestField label="CAMERA MOVEMENT" value={shot.cameraMovement} onChange={v => edit({ cameraMovement: v })} options={MOVEMENTS} placeholder="Slow push in" />
            <TextField label="LIGHTING" value={shot.lighting} onChange={v => edit({ lighting: v })} placeholder="Low-key, warm practicals" />
            <TextField label="MOOD" value={shot.mood} onChange={v => edit({ mood: v })} placeholder="Tense, quiet" />
            <label>DURATION (SECONDS)
              <input className="field" type="number" min={0} step={0.5} value={shot.durationSec ?? ""}
                onChange={e => { const n = parseFloat(e.target.value); edit({ durationSec: e.target.value === "" || !isFinite(n) || n < 0 ? null : n }); }} />
            </label>
            <label>STATUS
              <select className="field" value={shot.status} onChange={e => edit({ status: e.target.value as ShotStatus }, `Marked ${name} as ${e.target.value}`)}>
                {SHOT_STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </label>
          </div>

          <h4 className="sub-head">Continuity references</h4>
          <ContinuityPicker value={shot} onChange={patch => edit(patch, `Updated continuity for ${name}`)} />

          <h4 className="sub-head">Generated takes</h4>
          {shot.generatedAssetIds.length === 0
            ? <p className="muted small">Nothing generated yet. Use Image studio or Video studio above.</p>
            : <ReferenceImages
                assetIds={shot.generatedAssetIds} kinds={["image", "video"]} accept="image/*,video/*" activity={`Updated generated takes for ${name}`}
                link={(d, ids) => { const s = d.shots.find(x => x.id === shot.id); if (s) s.generatedAssetIds = [...new Set([...s.generatedAssetIds, ...ids])]; }}
                unlink={(d, id) => { const s = d.shots.find(x => x.id === shot.id); if (s) s.generatedAssetIds = s.generatedAssetIds.filter(a => a !== id); }}
              />}

          <h4 className="sub-head">Shot reference files</h4>
          <p className="muted small">Storyboard frames, mood images or clips specific to this shot.</p>
          <ReferenceImages
            assetIds={shot.assetIds} kinds={["image", "video"]} accept="image/*,video/*" activity={`Updated reference files for ${name}`}
            link={(d, ids) => { const s = d.shots.find(x => x.id === shot.id); if (s) s.assetIds = [...new Set([...s.assetIds, ...ids])]; }}
            unlink={(d, id) => { const s = d.shots.find(x => x.id === shot.id); if (s) s.assetIds = s.assetIds.filter(a => a !== id); }}
          />
          <TextField label="NOTES" multiline value={shot.notes} onChange={v => edit({ notes: v })} placeholder="Lens, blocking, sound, VFX notes…" />
        </div>
      )}
    </div>
  );
}
