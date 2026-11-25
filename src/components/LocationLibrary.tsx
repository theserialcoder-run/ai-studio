"use client";
import { useState } from "react";
import { assetById, makeAngle, makeLocation, nowIso, removeAngle, removeLocation } from "@/lib/projectModel";
import type { ID, Location, Project } from "@/lib/types";
import { AssetPreview, EmptyState, ReferenceImages, TextField, useStudio } from "./studio";

export function LocationLibrary() {
  const { ws, project } = useStudio();
  const [selected, setSelected] = useState<ID | null>(project.locations[0]?.id ?? null);
  const location = project.locations.find(l => l.id === selected) ?? project.locations[0];

  function add() {
    const l = makeLocation({ name: `Location ${project.locations.length + 1}` });
    ws.mutate(d => { d.locations.push(l); }, `Created location “${l.name}”`);
    setSelected(l.id);
  }

  return (
    <div className="content">
      <div className="section-head">
        <div><span className="eyebrow">CONTINUITY LIBRARY</span><h3>Locations</h3><p>Reusable environments with fixed details, reference images and camera angles.</p></div>
        <button className="button primary" onClick={add}>New location +</button>
      </div>
      <div className="library-layout">
        <div className="library-list">
          {project.locations.length === 0 && <EmptyState>No locations yet.</EmptyState>}
          {project.locations.map(l => {
            const img = assetById(project, l.primaryAssetId ?? l.referenceAssetIds[0]);
            return (
              <button key={l.id} className={`library-card${location?.id === l.id ? " active" : ""}`} onClick={() => setSelected(l.id)}>
                {img ? <AssetPreview asset={img} /> : <div className="asset-preview icon">⌂</div>}
                <span><strong>{l.name}</strong><small>{l.referenceAssetIds.length} refs · {l.angles.length} angles</small></span>
              </button>
            );
          })}
        </div>
        {location && <LocationEditor key={location.id} project={project} location={location} onDeleted={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function LocationEditor({ project, location: l, onDeleted }: { project: Project; location: Location; onDeleted: () => void }) {
  const { ws } = useStudio();
  const edit = (patch: Partial<Location>) => ws.mutate(d => {
    const x = d.locations.find(y => y.id === l.id);
    if (x) Object.assign(x, patch, { updatedAt: nowIso() });
  }, `Edited location “${l.name}”`);
  const find = (d: Project) => d.locations.find(y => y.id === l.id);
  const sceneCount = project.scenes.filter(s => s.locationId === l.id).length;
  const shotCount = project.shots.filter(s => s.locationId === l.id).length;

  return (
    <div className="library-editor">
      <div className="panel">
        <div className="panel-head"><h3>{l.name || "Unnamed location"}</h3><span className="muted">IN {sceneCount} SCENES · {shotCount} SHOTS</span></div>
        <TextField label="NAME" value={l.name} onChange={v => edit({ name: v })} />
        <TextField label="DESCRIPTION" multiline value={l.description} onChange={v => edit({ description: v })} placeholder="What this place is and how it feels" />
        <div className="form-grid">
          <TextField label="ARCHITECTURE" multiline value={l.architecture} onChange={v => edit({ architecture: v })} placeholder="Style, materials, era, condition" />
          <TextField label="ENVIRONMENT" multiline value={l.environment} onChange={v => edit({ environment: v })} placeholder="Interior/exterior, surroundings, weather, geography" />
          <TextField label="LAYOUT" multiline value={l.layout} onChange={v => edit({ layout: v })} placeholder="Room layout, furniture and prop positions, entrances" />
          <TextField label="LIGHTING" multiline value={l.lighting} onChange={v => edit({ lighting: v })} placeholder="Light sources, time-of-day variants" />
        </div>
        <TextField label="IMPORTANT VISUAL DETAILS (MUST NOT CHANGE)" multiline value={l.visualDetails} onChange={v => edit({ visualDetails: v })} placeholder="Green door on the left, cracked window, clock above the stove…" />
      </div>

      <div className="panel">
        <div className="panel-head"><div><h3>Master references</h3><p className="muted">Establishing views of the location. The primary image is listed first in continuity data.</p></div></div>
        <ReferenceImages
          assetIds={l.referenceAssetIds} primaryId={l.primaryAssetId} activity={`Updated references for “${l.name}”`}
          link={(d, ids) => { const x = find(d); if (!x) return; x.referenceAssetIds = [...new Set([...x.referenceAssetIds, ...ids])]; x.primaryAssetId ??= x.referenceAssetIds[0] ?? null; }}
          unlink={(d, id) => { const x = find(d); if (!x) return; x.referenceAssetIds = x.referenceAssetIds.filter(a => a !== id); if (x.primaryAssetId === id) x.primaryAssetId = x.referenceAssetIds[0] ?? null; }}
          setPrimary={(d, id) => { const x = find(d); if (x) x.primaryAssetId = id; }}
        />
      </div>

      <div className="panel">
        <div className="panel-head">
          <div><h3>Camera angles</h3><p className="muted">Named views of the same place (e.g. “From the doorway”). Shots can pick one.</p></div>
          <button className="text-button" onClick={() => ws.mutate(d => { find(d)?.angles.push(makeAngle({ name: `Angle ${l.angles.length + 1}` })); }, `Added a camera angle to “${l.name}”`)}>+ Add angle</button>
        </div>
        {l.angles.length === 0 && <p className="muted small">No saved angles yet.</p>}
        <div className="stack">
          {l.angles.map(a => {
            const findA = (d: Project) => find(d)?.angles.find(y => y.id === a.id);
            const editA = (patch: { name?: string; description?: string }) => ws.mutate(d => { const y = findA(d); if (y) Object.assign(y, patch); }, `Edited angle “${a.name}” of “${l.name}”`);
            return (
              <div key={a.id} className="item-card open">
                <div className="item-card-body">
                  <div className="form-grid">
                    <TextField label="ANGLE NAME" value={a.name} onChange={v => editA({ name: v })} placeholder="e.g. Reverse from the window" />
                    <TextField label="DESCRIPTION" multiline value={a.description} onChange={v => editA({ description: v })} placeholder="Camera position and what is visible" />
                  </div>
                  <ReferenceImages
                    assetIds={a.assetIds} activity={`Updated angle “${a.name}” of “${l.name}”`}
                    link={(d, ids) => { const y = findA(d); if (y) y.assetIds = [...new Set([...y.assetIds, ...ids])]; }}
                    unlink={(d, id) => { const y = findA(d); if (y) y.assetIds = y.assetIds.filter(x => x !== id); }}
                  />
                  <button className="tiny-button danger-text" onClick={() => { if (confirm(`Delete angle “${a.name}”?`)) ws.mutate(d => removeAngle(d, l.id, a.id), `Deleted angle “${a.name}” of “${l.name}”`); }}>Delete angle</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="danger-zone panel">
        <p>Deleting a location unlinks it from all scenes and shots. Its uploaded images stay in the asset library.</p>
        <button className="button secondary danger-text" onClick={() => { if (confirm(`Delete location “${l.name}”?`)) { ws.mutate(d => removeLocation(d, l.id), `Deleted location “${l.name}”`); onDeleted(); } }}>Delete location</button>
      </div>
    </div>
  );
}
