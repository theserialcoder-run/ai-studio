"use client";
import type { ProviderInfo } from "@/lib/ai/types";
import { useStudio } from "./studio";

function ProviderRow({ p, kind, active }: { p: ProviderInfo; kind: string; active?: boolean }) {
  return (
    <div className="provider-row">
      <span className="provider-icon">{kind === "llm" ? "✳" : kind === "image" ? "▧" : kind === "audio" ? "♪" : "▷"}</span>
      <div>
        <b>{p.label}{active ? " · in use" : ""}</b>
        <small>{p.vendor} · <code>{p.model}</code></small>
        <small>{p.conditioning}</small>
        <small>{p.costNote}</small>
        {!p.configured && <small className="warn-text">Setup: {p.setup}</small>}
      </div>
      <span className={`connection-pill${p.configured ? " ok" : " warn"}`}>{p.configured ? (p.billing === "paid" ? "Ready · paid" : "Ready · free tier") : "Not configured"}</span>
    </div>
  );
}

function ProvidersPanel() {
  const { ai } = useStudio();
  const prov = ai.providers;
  return (
    <div className="panel">
      <div className="panel-head"><h3>AI providers</h3><button className="text-button" onClick={() => void ai.refreshProviders()}>Refresh</button></div>
      {ai.providersError && <p className="error-text">{ai.providersError}</p>}
      {!prov && !ai.providersError && <p className="muted small">Loading…</p>}
      {prov && <>
        <span className="field-label">TEXT (COMPANION &amp; SCRIPT ASSISTANT)</span>
        {prov.llm.map(p => <ProviderRow key={p.id} p={p} kind="llm" active={prov.activeLlm === p.id} />)}
        <span className="field-label">IMAGE</span>
        {prov.image.map(p => <ProviderRow key={p.id} p={p} kind="image" />)}
        <span className="field-label">VIDEO</span>
        {prov.video.map(p => <ProviderRow key={p.id} p={p} kind="video" />)}
        <span className="field-label">VOICE (TEXT-TO-SPEECH)</span>
        {prov.audio.map(p => <ProviderRow key={p.id} p={p} kind="audio" />)}
      </>}
      <p className="muted small">Keys live only in <code>.env.local</code> on the server (never in the browser). After editing it, restart the server and press Refresh. Paid providers always ask for confirmation before each generation. Full guide: docs/PROVIDERS.md.</p>
    </div>
  );
}

export function exportProjectJson(project: { name: string }) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "film"}-project.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SettingsView() {
  const { ws, project, notify } = useStudio();
  return (
    <div className="content">
      <div className="section-head"><div><span className="eyebrow">PROJECT &amp; CONNECTIONS</span><h3>Settings</h3><p>Configure your project identity and optional AI providers.</p></div></div>
      <div className="settings-grid">
        <div className="panel">
          <h3>Project settings</h3>
          <label>PROJECT NAME<input className="field" value={project.name} onChange={e => ws.mutate(d => { d.name = e.target.value; }, "Edited project settings")} /></label>
          <label>LOGLINE<input className="field" value={project.logline} onChange={e => ws.mutate(d => { d.logline = e.target.value; }, "Edited project settings")} placeholder="A one-sentence summary of your film" /></label>
          <label>VISUAL STYLE / STYLE BIBLE<textarea className="field textarea-small" value={project.style} onChange={e => ws.mutate(d => { d.style = e.target.value; }, "Edited the style bible")} /></label>
          <p className="muted small">The style bible is included in prepared image and video prompts.</p>
        </div>
        <ProvidersPanel />
      </div>
      <div className="panel danger-zone">
        <h3>Project data</h3>
        <p>
          Projects are saved on this computer by the Wonderboy server in <code>data/projects/{project.id}/</code>: the project document
          is <code>project.json</code> and uploaded files are in <code>files/</code>. The JSON export contains all records and file metadata, but not the files themselves.
        </p>
        <div className="button-row">
          <button className="button secondary" onClick={() => exportProjectJson(project)}>Export project JSON</button>
          <button className="button secondary danger-text" onClick={() => {
            if (confirm(`Delete “${project.name}” and all of its uploaded files? This cannot be undone.`)) {
              ws.deleteProject(project.id).then(() => notify("Project deleted."), e => notify(e instanceof Error ? e.message : "Delete failed"));
            }
          }}>Delete project</button>
        </div>
      </div>
    </div>
  );
}
