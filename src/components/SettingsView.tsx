"use client";
import { useStudio } from "./studio";

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
          <p className="muted small">The style bible is included in every image and video continuity request.</p>
        </div>
        <div className="panel">
          <h3>Provider connections</h3>
          <div className="provider-row"><span className="provider-icon">✳</span><div><b>Google Gemini</b><small>Chat and script assistance</small></div><span className="connection-pill">API key optional</span></div>
          <div className="provider-row"><span className="provider-icon">▧</span><div><b>Image provider</b><small>Connect a compatible hosted inference API</small></div><span className="connection-pill">Not connected</span></div>
          <div className="provider-row"><span className="provider-icon">▷</span><div><b>Video provider</b><small>Connect a hosted video model API</small></div><span className="connection-pill">Not connected</span></div>
          <p className="muted small">Set keys in .env.local. Read docs/PROVIDERS.md before connecting a provider.</p>
        </div>
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
