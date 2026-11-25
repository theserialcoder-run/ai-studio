"use client";
import { useState } from "react";
import { timeAgo } from "@/lib/projectModel";
import type { Workspace } from "@/lib/client/useWorkspace";
import { EmptyState } from "./studio";

/** Project management. Works even when no project is open, so it doesn't use the studio context. */
export function ProjectsView({ ws, notify, onOpened }: { ws: Workspace; notify: (m: string) => void; onOpened: () => void }) {
  const [name, setName] = useState("");
  const [logline, setLogline] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try { await fn(); if (done) notify(done); } catch (e) { notify(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); }
  }

  return (
    <div className="content">
      <div className="section-head"><div><span className="eyebrow">YOUR FILMS</span><h3>Projects</h3><p>Each project keeps its own scripts, scenes, shots, characters, locations and files.</p></div></div>
      <div className="projects-layout">
        <form className="panel" onSubmit={e => { e.preventDefault(); if (!name.trim()) return; void run(async () => { await ws.createProject({ name, logline }); setName(""); setLogline(""); onOpened(); }, "Project created."); }}>
          <div className="panel-head"><h3>New project</h3></div>
          <label>PROJECT NAME<input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. The Disturbance" /></label>
          <label>LOGLINE<textarea className="field textarea-small" value={logline} onChange={e => setLogline(e.target.value)} placeholder="One sentence describing the film" /></label>
          <button className="button primary full" disabled={busy || !name.trim()}>Create project</button>
        </form>

        <div className="project-list">
          {ws.projects.length === 0 && <EmptyState>No projects yet. Create your first film on the left.</EmptyState>}
          {ws.projects.map(p => {
            const active = ws.project?.id === p.id;
            return (
              <div key={p.id} className={`panel project-card${active ? " active" : ""}`}>
                <div className="project-card-main">
                  {renaming === p.id ? (
                    <form className="inline-form" onSubmit={e => { e.preventDefault(); void run(async () => { await ws.renameProject(p.id, renameValue); setRenaming(null); }, "Project renamed."); }}>
                      <input className="field" autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} />
                      <button className="button primary" disabled={!renameValue.trim()}>Save</button>
                      <button type="button" className="button secondary" onClick={() => setRenaming(null)}>Cancel</button>
                    </form>
                  ) : (
                    <h3>{p.name}{active && <span className="badge">Open</span>}</h3>
                  )}
                  <p className="muted">{p.logline || "No logline yet."}</p>
                  <div className="meta-row">
                    <span>{p.counts.scenes} scenes</span><span>{p.counts.shots} shots</span><span>{p.counts.characters} characters</span>
                    <span>{p.counts.locations} locations</span><span>{p.counts.assets} files</span><span>Updated {timeAgo(p.updatedAt)}</span>
                  </div>
                </div>
                <div className="project-card-actions">
                  {!active && <button className="button primary" disabled={busy} onClick={() => void run(async () => { await ws.openProject(p.id); onOpened(); })}>Open</button>}
                  <button className="button secondary" disabled={busy} onClick={() => { setRenaming(p.id); setRenameValue(p.name); }}>Rename</button>
                  <button className="tiny-button danger-text" disabled={busy}
                    onClick={() => { if (confirm(`Delete “${p.name}” and all of its uploaded files? This cannot be undone.`)) void run(() => ws.deleteProject(p.id), "Project deleted."); }}>
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
