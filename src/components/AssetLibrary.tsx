"use client";
import { useMemo, useState } from "react";
import { fileUrl, formatBytes, removeAsset, shotNumber, timeAgo } from "@/lib/projectModel";
import type { Asset, AssetKind, ID, Project } from "@/lib/types";
import { AssetPreview, EmptyState, Modal, UploadButton, assetLabel, useStudio } from "./studio";

const KINDS: (AssetKind | "all")[] = ["all", "image", "video", "audio", "document", "other"];

interface Usage { key: string; label: string; unlink: (d: Project) => void }

/** Every record that references the asset, with a way to unlink it. */
function usagesOf(p: Project, assetId: ID): Usage[] {
  const out: Usage[] = [];
  const without = (ids: ID[]) => ids.filter(a => a !== assetId);
  for (const c of p.characters) {
    if (c.referenceAssetIds.includes(assetId)) out.push({ key: `c${c.id}`, label: `Character · ${c.name}`, unlink: d => { const x = d.characters.find(y => y.id === c.id); if (x) { x.referenceAssetIds = without(x.referenceAssetIds); if (x.primaryAssetId === assetId) x.primaryAssetId = x.referenceAssetIds[0] ?? null; } } });
    for (const v of c.variations) if (v.assetIds.includes(assetId)) out.push({ key: `v${v.id}`, label: `Character · ${c.name} · ${v.name}`, unlink: d => { const y = d.characters.find(x => x.id === c.id)?.variations.find(x => x.id === v.id); if (y) y.assetIds = without(y.assetIds); } });
  }
  for (const l of p.locations) {
    if (l.referenceAssetIds.includes(assetId)) out.push({ key: `l${l.id}`, label: `Location · ${l.name}`, unlink: d => { const x = d.locations.find(y => y.id === l.id); if (x) { x.referenceAssetIds = without(x.referenceAssetIds); if (x.primaryAssetId === assetId) x.primaryAssetId = x.referenceAssetIds[0] ?? null; } } });
    for (const a of l.angles) if (a.assetIds.includes(assetId)) out.push({ key: `a${a.id}`, label: `Location · ${l.name} · ${a.name}`, unlink: d => { const y = d.locations.find(x => x.id === l.id)?.angles.find(x => x.id === a.id); if (y) y.assetIds = without(y.assetIds); } });
  }
  for (const s of p.shots) if (s.generatedAssetIds.includes(assetId)) out.push({ key: `g${s.id}`, label: `Shot ${shotNumber(p, s)} · generated take`, unlink: d => { const x = d.shots.find(y => y.id === s.id); if (x) x.generatedAssetIds = without(x.generatedAssetIds); } });
  for (const s of p.shots) if (s.assetIds.includes(assetId)) out.push({ key: `s${s.id}`, label: `Shot ${shotNumber(p, s)}${s.title ? ` · ${s.title}` : ""}`, unlink: d => { const x = d.shots.find(y => y.id === s.id); if (x) x.assetIds = without(x.assetIds); } });
  for (const c of p.storyCuts) {
    if (c.sources.some(s => s.assetId === assetId)) out.push({ key: `sc${c.id}`, label: `Story cut · ${c.title} (footage; unlinking removes its scenes)`, unlink: d => { const x = d.storyCuts.find(y => y.id === c.id); if (x) { x.sources = x.sources.filter(s => s.assetId !== assetId); x.segments = x.segments.filter(s => s.assetId !== assetId); } } });
    if (c.outputAssetIds.includes(assetId)) out.push({ key: `so${c.id}`, label: `Story cut · ${c.title} (render)`, unlink: d => { const x = d.storyCuts.find(y => y.id === c.id); if (x) x.outputAssetIds = without(x.outputAssetIds); } });
  }
  return out;
}

/** Link targets encoded as "<type>:<id>[:<subId>]". */
function linkAsset(d: Project, target: string, assetId: ID) {
  const [type, a, b] = target.split(":");
  const add = (ids: ID[]) => (ids.includes(assetId) ? ids : [...ids, assetId]);
  if (type === "char") { const c = d.characters.find(x => x.id === a); if (c) { c.referenceAssetIds = add(c.referenceAssetIds); c.primaryAssetId ??= assetId; } }
  if (type === "var") { const v = d.characters.find(x => x.id === a)?.variations.find(x => x.id === b); if (v) v.assetIds = add(v.assetIds); }
  if (type === "loc") { const l = d.locations.find(x => x.id === a); if (l) { l.referenceAssetIds = add(l.referenceAssetIds); l.primaryAssetId ??= assetId; } }
  if (type === "angle") { const g = d.locations.find(x => x.id === a)?.angles.find(x => x.id === b); if (g) g.assetIds = add(g.assetIds); }
  if (type === "shot") { const s = d.shots.find(x => x.id === a); if (s) s.assetIds = add(s.assetIds); }
  if (type === "take") { const s = d.shots.find(x => x.id === a); if (s) s.generatedAssetIds = add(s.generatedAssetIds); }
}

export function AssetLibrary() {
  const { ws, project } = useStudio();
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [query, setQuery] = useState("");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [openId, setOpenId] = useState<ID | null>(null);

  const usageCount = useMemo(() => {
    const m = new Map<ID, number>();
    for (const a of project.assets) m.set(a.id, usagesOf(project, a.id).length);
    return m;
  }, [project]);

  const q = query.trim().toLowerCase();
  const list = project.assets
    .filter(a => kind === "all" || a.kind === kind)
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.tags.some(t => t.toLowerCase().includes(q)) || a.notes.toLowerCase().includes(q))
    .filter(a => !unusedOnly || !usageCount.get(a.id))
    .slice()
    .reverse(); // newest first
  const open = project.assets.find(a => a.id === openId);
  const totalSize = project.assets.reduce((n, a) => n + a.size, 0);

  return (
    <div className="content">
      <div className="section-head">
        <div><span className="eyebrow">PROJECT FILES</span><h3>Asset library</h3><p>{project.assets.length} files · {formatBytes(totalSize)}. Link any file to characters, locations and shots — it is stored once and reused.</p></div>
        <UploadButton label="Upload files +" className="button primary" onFiles={files => ws.uploadFiles(files)} />
      </div>

      <div className="panel toolbar">
        <label className="grow">SEARCH<input className="field" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, tag or note" /></label>
        <label>TYPE
          <select className="field" value={kind} onChange={e => setKind(e.target.value as AssetKind | "all")}>
            {KINDS.map(k => <option key={k} value={k}>{k === "all" ? "All types" : k}</option>)}
          </select>
        </label>
        <label className="check inline"><input type="checkbox" checked={unusedOnly} onChange={e => setUnusedOnly(e.target.checked)} /><span>Unused only</span></label>
      </div>

      {list.length === 0
        ? <EmptyState>{project.assets.length ? "No files match these filters." : "No files yet. Upload images, videos, audio or documents."}</EmptyState>
        : <div className="asset-grid">
            {list.map(a => (
              <button key={a.id} className="asset-card" onClick={() => setOpenId(a.id)}>
                <AssetPreview asset={a} />
                <span className="asset-card-body">
                  <strong title={a.name}>{a.name}</strong>
                  <small>{assetLabel(a)} · {usageCount.get(a.id) ? `used ${usageCount.get(a.id)}×` : "unused"}</small>
                  {a.tags.length > 0 && <span className="chip-row">{a.tags.slice(0, 3).map(t => <span key={t} className="chip static">{t}</span>)}</span>}
                </span>
              </button>
            ))}
          </div>}

      {open && <AssetDetail key={open.id} asset={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function AssetDetail({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const { ws, project } = useStudio();
  const [target, setTarget] = useState("");
  const usages = usagesOf(project, asset.id);
  const edit = (patch: Partial<Asset>) => ws.mutate(d => { const a = d.assets.find(x => x.id === asset.id); if (a) Object.assign(a, patch); }, `Edited file “${asset.name}”`);
  const isImage = asset.kind === "image";

  return (
    <Modal title={asset.name} onClose={onClose} wide>
      <div className="asset-detail">
        <div className="asset-detail-preview"><AssetPreview asset={asset} controls /></div>
        <div>
          <label>NAME<input className="field" value={asset.name} onChange={e => edit({ name: e.target.value })} /></label>
          <label>TAGS (COMMA-SEPARATED)
            <input className="field" defaultValue={asset.tags.join(", ")} placeholder="storyboard, prop, mood"
              onBlur={e => edit({ tags: [...new Set(e.target.value.split(",").map(t => t.trim()).filter(Boolean))] })} />
          </label>
          <label>NOTES<textarea className="field textarea-small" value={asset.notes} onChange={e => edit({ notes: e.target.value })} /></label>
          <p className="muted small">{asset.mimeType} · {formatBytes(asset.size)} · uploaded {timeAgo(asset.createdAt)}</p>

          <span className="field-label">USED BY</span>
          {usages.length === 0 ? <p className="muted small">Not linked to anything yet.</p> : (
            <ul className="usage-list">
              {usages.map(u => <li key={u.key}><span>{u.label}</span><button className="tiny-button" onClick={() => ws.mutate(u.unlink, `Unlinked “${asset.name}” from ${u.label}`)}>Unlink</button></li>)}
            </ul>
          )}

          <div className="inline-form">
            <select className="field" aria-label="Link to" value={target} onChange={e => setTarget(e.target.value)}>
              <option value="">Link to…</option>
              {project.characters.length > 0 && (
                <optgroup label={isImage ? "Characters" : "Characters (images only)"}>
                  {project.characters.flatMap(c => [
                    <option key={c.id} value={`char:${c.id}`} disabled={!isImage}>{c.name} — identity</option>,
                    ...c.variations.map(v => <option key={v.id} value={`var:${c.id}:${v.id}`} disabled={!isImage}>{c.name} — {v.name}</option>),
                  ])}
                </optgroup>
              )}
              {project.locations.length > 0 && (
                <optgroup label={isImage ? "Locations" : "Locations (images only)"}>
                  {project.locations.flatMap(l => [
                    <option key={l.id} value={`loc:${l.id}`} disabled={!isImage}>{l.name} — master</option>,
                    ...l.angles.map(a => <option key={a.id} value={`angle:${l.id}:${a.id}`} disabled={!isImage}>{l.name} — {a.name}</option>),
                  ])}
                </optgroup>
              )}
              {project.shots.length > 0 && (
                <optgroup label="Shots — reference">
                  {project.shots.map(s => <option key={s.id} value={`shot:${s.id}`}>Shot {shotNumber(project, s)}{s.title ? ` · ${s.title}` : ""}</option>)}
                </optgroup>
              )}
              {project.shots.length > 0 && (
                <optgroup label="Shots — generated take">
                  {project.shots.map(s => <option key={s.id} value={`take:${s.id}`}>Shot {shotNumber(project, s)}{s.title ? ` · ${s.title}` : ""}</option>)}
                </optgroup>
              )}
            </select>
            <button className="button secondary" disabled={!target} onClick={() => { ws.mutate(d => linkAsset(d, target, asset.id), `Linked “${asset.name}”`); setTarget(""); }}>Link</button>
          </div>

          <div className="button-row modal-actions">
            <a className="button secondary" href={fileUrl(project.id, asset.id)} download={asset.name}>Download</a>
            <button className="button secondary danger-text" onClick={() => {
              if (!confirm(`Delete “${asset.name}”? It will be unlinked from ${usages.length} record(s) and the file removed from disk.`)) return;
              ws.mutate(d => removeAsset(d, asset.id), `Deleted file “${asset.name}”`);
              onClose();
            }}>Delete file</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
