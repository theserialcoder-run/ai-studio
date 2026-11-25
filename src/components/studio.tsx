"use client";
// Shared UI building blocks and the studio context used by every view.
import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import { assetById, fileUrl, formatBytes } from "@/lib/projectModel";
import type { Workspace } from "@/lib/client/useWorkspace";
import type { AiState } from "@/lib/client/useAi";
import type { Asset, AssetKind, ID, Project } from "@/lib/types";

export const TABS = [
  "Overview", "Projects", "AI Companion", "Script", "Shots", "Characters", "Locations", "Assets", "Image Studio", "Video Studio", "Settings",
] as const;
export type Tab = (typeof TABS)[number];

export interface StudioCtx {
  ws: Workspace;
  ai: AiState;
  project: Project;
  notify: (message: string) => void;
  go: (tab: Tab) => void;
  /** Shot preselected when opening Image/Video Studio from the shot planner. */
  focusShotId: ID | null;
  setFocusShotId: (id: ID | null) => void;
  /** Scene preselected when opening the shot planner from the script studio. */
  focusSceneId: ID | null;
  setFocusSceneId: (id: ID | null) => void;
  /** Image to use as source / start frame when Image or Video Studio opens next. */
  pendingSourceId: ID | null;
  setPendingSourceId: (id: ID | null) => void;
}

export const StudioContext = createContext<StudioCtx | null>(null);

export function useStudio(): StudioCtx {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used inside an open project");
  return ctx;
}

/* ----------------------------------------------------------------- form bits */

export function TextField({ label, value, onChange, placeholder, multiline, rows, mono }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; rows?: number; mono?: boolean;
}) {
  return (
    <label>
      {label}
      {multiline
        ? <textarea className={`field${mono ? " mono-field" : ""}`} rows={rows ?? 3} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
        : <input className="field" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />}
    </label>
  );
}

/** Free text input with suggestions (camera angle, framing, …). */
export function SuggestField({ label, value, onChange, options, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; options: string[]; placeholder?: string;
}) {
  const listId = useId();
  return (
    <label>
      {label}
      <input className="field" list={listId} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
      <datalist id={listId}>{options.map(o => <option key={o} value={o} />)}</datalist>
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head"><h3>{title}</h3><button className="tiny-button" onClick={onClose}>Close ✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/* -------------------------------------------------------------------- assets */

const KIND_ICON: Record<AssetKind, string> = { image: "▧", video: "▷", audio: "♪", document: "≡", other: "◇" };

export function AssetPreview({ asset, controls }: { asset: Asset; controls?: boolean }) {
  const { project } = useStudio();
  const url = fileUrl(project.id, asset.id);
  if (asset.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="asset-preview" src={url} alt={asset.name} loading="lazy" />;
  }
  if (asset.kind === "video") return <video className="asset-preview" src={url} controls={controls} preload="metadata" muted={!controls} />;
  if (asset.kind === "audio" && controls) return <div className="asset-preview icon"><audio src={url} controls preload="none" /></div>;
  return <div className="asset-preview icon">{KIND_ICON[asset.kind]}</div>;
}

export function assetLabel(a: Asset) {
  return `${a.kind} · ${formatBytes(a.size)}`;
}

/** Upload button; calls onFiles with the chosen files. */
export function UploadButton({ label, accept, multiple = true, onFiles, className = "button secondary" }: {
  label: string; accept?: string; multiple?: boolean; onFiles: (files: File[]) => Promise<unknown>; className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = useStudio();
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : label}</button>
      <input
        ref={input} type="file" hidden accept={accept} multiple={multiple}
        onChange={async e => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!files.length) return;
          setBusy(true);
          try { await onFiles(files); } catch (err) { notify(err instanceof Error ? err.message : "Upload failed"); } finally { setBusy(false); }
        }}
      />
    </>
  );
}

/** Choose existing assets from the project library. */
export function AssetPicker({ kinds = ["image"], exclude = [], onPick, onClose, title = "Choose from asset library" }: {
  kinds?: AssetKind[]; exclude?: ID[]; onPick: (ids: ID[]) => void; onClose: () => void; title?: string;
}) {
  const { project } = useStudio();
  const [chosen, setChosen] = useState<ID[]>([]);
  const options = project.assets.filter(a => kinds.includes(a.kind) && !exclude.includes(a.id));
  return (
    <Modal title={title} onClose={onClose} wide>
      {options.length === 0
        ? <EmptyState>No matching assets in this project yet. Upload files in the Assets library or use the upload button.</EmptyState>
        : <div className="picker-grid">
            {options.map(a => (
              <button key={a.id} type="button" className={`picker-item${chosen.includes(a.id) ? " selected" : ""}`}
                onClick={() => setChosen(c => (c.includes(a.id) ? c.filter(x => x !== a.id) : [...c, a.id]))}>
                <AssetPreview asset={a} />
                <span>{a.name}</span>
              </button>
            ))}
          </div>}
      <div className="button-row modal-actions">
        <button className="button primary" disabled={!chosen.length} onClick={() => { onPick(chosen); onClose(); }}>Add {chosen.length || ""} selected</button>
        <button className="button secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * Reference-image manager for any record (character, variation, location,
 * angle, shot). Linking only stores asset IDs; files stay in the asset library.
 */
export function ReferenceImages({ assetIds, primaryId, link, unlink, setPrimary, activity, kinds = ["image"], accept = "image/*" }: {
  assetIds: ID[];
  primaryId?: ID | null;
  link: (draft: Project, ids: ID[]) => void;
  unlink: (draft: Project, id: ID) => void;
  setPrimary?: (draft: Project, id: ID) => void;
  activity: string;
  kinds?: AssetKind[];
  accept?: string;
}) {
  const { ws, project } = useStudio();
  const [picking, setPicking] = useState(false);
  const assets = assetIds.map(id => assetById(project, id)).filter((a): a is Asset => !!a);
  return (
    <div className="ref-images">
      {assets.length === 0
        ? <p className="muted small">No reference files linked yet.</p>
        : <div className="thumb-grid">
            {assets.map(a => (
              <figure key={a.id} className={`thumb${primaryId === a.id ? " primary" : ""}`}>
                <AssetPreview asset={a} />
                <figcaption>
                  <span title={a.name}>{a.name}</span>
                  <span className="thumb-actions">
                    {setPrimary && (primaryId === a.id
                      ? <em className="gold">★ Primary</em>
                      : <button className="tiny-button" onClick={() => ws.mutate(d => setPrimary(d, a.id), activity)}>☆ Primary</button>)}
                    <button className="tiny-button" onClick={() => ws.mutate(d => unlink(d, a.id), activity)}>Unlink</button>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>}
      <div className="button-row">
        <UploadButton label="Upload images" accept={accept} onFiles={files => ws.uploadFiles(files, (d, added) => link(d, added.map(a => a.id)), activity)} />
        <button type="button" className="button secondary" onClick={() => setPicking(true)}>Add from library</button>
      </div>
      {picking && <AssetPicker kinds={kinds} exclude={assetIds} onPick={ids => ws.mutate(d => link(d, ids), activity)} onClose={() => setPicking(false)} />}
    </div>
  );
}

/** Small up/down/duplicate/delete control group. */
export function RowActions({ onUp, onDown, onDuplicate, onDelete, deleteLabel = "Delete" }: {
  onUp?: () => void; onDown?: () => void; onDuplicate?: () => void; onDelete?: () => void; deleteLabel?: string;
}) {
  return (
    <span className="row-actions">
      {onUp && <button className="icon-mini" title="Move up" aria-label="Move up" onClick={onUp}>↑</button>}
      {onDown && <button className="icon-mini" title="Move down" aria-label="Move down" onClick={onDown}>↓</button>}
      {onDuplicate && <button className="tiny-button" onClick={onDuplicate}>Duplicate</button>}
      {onDelete && <button className="tiny-button danger-text" onClick={onDelete}>{deleteLabel}</button>}
    </span>
  );
}
