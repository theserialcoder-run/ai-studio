"use client";
import { useState } from "react";
import { assetById, makeCharacter, makeVariation, nowIso, removeCharacter, removeVariation } from "@/lib/projectModel";
import type { Character, ID, Project } from "@/lib/types";
import { AssetPreview, EmptyState, ReferenceImages, TextField, useStudio } from "./studio";

export function CharacterLibrary() {
  const { ws, project } = useStudio();
  const [selected, setSelected] = useState<ID | null>(project.characters[0]?.id ?? null);
  const character = project.characters.find(c => c.id === selected) ?? project.characters[0];

  function add() {
    const c = makeCharacter({ name: `Character ${project.characters.length + 1}` });
    ws.mutate(d => { d.characters.push(c); }, `Created character “${c.name}”`);
    setSelected(c.id);
  }

  return (
    <div className="content">
      <div className="section-head">
        <div><span className="eyebrow">CONTINUITY LIBRARY</span><h3>Characters</h3><p>Reusable character records: identity, wardrobe variations and reference images.</p></div>
        <button className="button primary" onClick={add}>New character +</button>
      </div>
      <div className="library-layout">
        <div className="library-list">
          {project.characters.length === 0 && <EmptyState>No characters yet.</EmptyState>}
          {project.characters.map(c => {
            const img = assetById(project, c.primaryAssetId ?? c.referenceAssetIds[0]);
            return (
              <button key={c.id} className={`library-card${character?.id === c.id ? " active" : ""}`} onClick={() => setSelected(c.id)}>
                {img ? <AssetPreview asset={img} /> : <div className="asset-preview icon">◉</div>}
                <span><strong>{c.name}</strong><small>{c.referenceAssetIds.length} refs · {c.variations.length} variations</small></span>
              </button>
            );
          })}
        </div>
        {character && <CharacterEditor key={character.id} project={project} character={character} onDeleted={() => setSelected(null)} />}
      </div>
    </div>
  );
}

function CharacterEditor({ project, character: c, onDeleted }: { project: Project; character: Character; onDeleted: () => void }) {
  const { ws } = useStudio();
  const activity = `Edited character “${c.name}”`;
  const edit = (patch: Partial<Character>) => ws.mutate(d => {
    const x = d.characters.find(y => y.id === c.id);
    if (x) Object.assign(x, patch, { updatedAt: nowIso() });
  }, activity);
  const find = (d: Project) => d.characters.find(y => y.id === c.id);
  const sceneCount = project.scenes.filter(s => s.characterIds.includes(c.id)).length;
  const shotCount = project.shots.filter(s => s.characters.some(r => r.characterId === c.id)).length;

  return (
    <div className="library-editor">
      <div className="panel">
        <div className="panel-head">
          <h3>{c.name || "Unnamed character"}</h3>
          <span className="muted">IN {sceneCount} SCENES · {shotCount} SHOTS</span>
        </div>
        <TextField label="NAME" value={c.name} onChange={v => edit({ name: v })} />
        <TextField label="DESCRIPTION" multiline value={c.description} onChange={v => edit({ description: v })} placeholder="Who they are, their role in the story" />
        <div className="form-grid">
          <TextField label="PHYSICAL APPEARANCE (IDENTITY)" multiline value={c.appearance} onChange={v => edit({ appearance: v })} placeholder="Face, age appearance, hair, build, skin tone, distinctive marks…" />
          <TextField label="DEFAULT CLOTHING" multiline value={c.clothing} onChange={v => edit({ clothing: v })} placeholder="Their usual wardrobe" />
          <TextField label="PERSONALITY" multiline value={c.personality} onChange={v => edit({ personality: v })} placeholder="Temperament, mannerisms, how they move" />
          <TextField label="NOTES" multiline value={c.notes} onChange={v => edit({ notes: v })} placeholder="Things that must never change, casting notes…" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div><h3>Identity references</h3><p className="muted">Face, front, side and full-body images. The primary image is listed first in continuity data.</p></div></div>
        <ReferenceImages
          assetIds={c.referenceAssetIds} primaryId={c.primaryAssetId} activity={`Updated references for “${c.name}”`}
          link={(d, ids) => { const x = find(d); if (!x) return; x.referenceAssetIds = [...new Set([...x.referenceAssetIds, ...ids])]; x.primaryAssetId ??= x.referenceAssetIds[0] ?? null; }}
          unlink={(d, id) => { const x = find(d); if (!x) return; x.referenceAssetIds = x.referenceAssetIds.filter(a => a !== id); if (x.primaryAssetId === id) x.primaryAssetId = x.referenceAssetIds[0] ?? null; }}
          setPrimary={(d, id) => { const x = find(d); if (x) x.primaryAssetId = id; }}
        />
      </div>

      <div className="panel">
        <div className="panel-head">
          <div><h3>Wardrobe &amp; appearance variations</h3><p className="muted">Costume changes, ageing, injuries… Identity fields above stay the same.</p></div>
          <button className="text-button" onClick={() => ws.mutate(d => { find(d)?.variations.push(makeVariation({ name: `Variation ${c.variations.length + 1}` })); }, `Added a variation to “${c.name}”`)}>+ Add variation</button>
        </div>
        {c.variations.length === 0 && <p className="muted small">No variations. Shots use the default clothing.</p>}
        <div className="stack">
          {c.variations.map(v => {
            const findV = (d: Project) => find(d)?.variations.find(y => y.id === v.id);
            const editV = (patch: { name?: string; description?: string }) => ws.mutate(d => { const y = findV(d); if (y) Object.assign(y, patch); }, `Edited variation “${v.name}” of “${c.name}”`);
            return (
              <div key={v.id} className="item-card open">
                <div className="item-card-body">
                  <div className="form-grid">
                    <TextField label="VARIATION NAME" value={v.name} onChange={val => editV({ name: val })} placeholder="e.g. Rain-soaked coat" />
                    <TextField label="WHAT CHANGES" multiline value={v.description} onChange={val => editV({ description: val })} placeholder="Wardrobe / appearance differences only" />
                  </div>
                  <ReferenceImages
                    assetIds={v.assetIds} activity={`Updated variation “${v.name}” of “${c.name}”`}
                    link={(d, ids) => { const y = findV(d); if (y) y.assetIds = [...new Set([...y.assetIds, ...ids])]; }}
                    unlink={(d, id) => { const y = findV(d); if (y) y.assetIds = y.assetIds.filter(a => a !== id); }}
                  />
                  <button className="tiny-button danger-text" onClick={() => { if (confirm(`Delete variation “${v.name}”? Shots using it fall back to the default wardrobe.`)) ws.mutate(d => removeVariation(d, c.id, v.id), `Deleted variation “${v.name}” of “${c.name}”`); }}>Delete variation</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="danger-zone panel">
        <p>Deleting a character removes it from all scenes and shots. Its uploaded images stay in the asset library.</p>
        <button className="button secondary danger-text" onClick={() => { if (confirm(`Delete character “${c.name}”?`)) { ws.mutate(d => removeCharacter(d, c.id), `Deleted character “${c.name}”`); onDeleted(); } }}>Delete character</button>
      </div>
    </div>
  );
}
