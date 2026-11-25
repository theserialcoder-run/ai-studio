"use client";
import { useEffect, useState } from "react";
import { billingLabel, type ComfyStatus, type ProviderInfo } from "@/lib/ai/types";
import { aiApi } from "@/lib/client/ai";
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
      <span className={`connection-pill${p.configured ? " ok" : " warn"}`}>{p.configured ? `Ready · ${billingLabel(p.billing)}` : "Not configured"}</span>
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

/** Shell commands that download missing model files into a ComfyUI install (run in its folder). */
function downloadScript(st: ComfyStatus): string {
  const files = (st.check?.workflows ?? []).flatMap(w => w.files).filter(f => !f.present);
  const unique = [...new Map(files.map(f => [`${f.folder}/${f.name}`, f])).values()];
  return unique.map(f => `wget -c "${f.url}" -O "models/${f.folder}/${f.name}"`).join("\n");
}

function ComfyPanel() {
  const { ai, notify } = useStudio();
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "check">("");
  const [error, setError] = useState("");

  useEffect(() => {
    aiApi.comfyStatus(false).then(s => { setStatus(s); setUrl(s.url); }, e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function save(next: { url: string; authHeader?: string; clearAuth?: boolean }) {
    setBusy("save"); setError("");
    try {
      const s = await aiApi.saveComfy(next);
      setStatus(s); setUrl(s.url); setAuth("");
      await ai.refreshProviders();
      notify(s.url ? "ComfyUI address saved." : "ComfyUI disconnected.");
      if (s.url) await check();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function check() {
    setBusy("check"); setError("");
    try {
      setStatus(await aiApi.comfyStatus(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  const c = status?.check;
  const script = status && c?.ok ? downloadScript(status) : "";
  return (
    <div className="panel comfy-panel">
      <div className="panel-head">
        <h3>ComfyUI GPU</h3>
        <span className={`connection-pill${status?.url ? (c?.ok === false ? " warn" : " ok") : " warn"}`}>
          {!status?.url ? "Not connected" : c ? (c.ok ? "Connected" : "Not reachable") : "Address saved"}
        </span>
      </div>
      <p className="muted small">
        Unlimited images on a GPU you rent by the hour (e.g. RunPod). Wonderboy sends jobs to ComfyUI running on that GPU, with no per-image fee.
        Wonderboy does not start or stop the pod: start it on RunPod, and <strong>stop it when you&apos;re done</strong>, because you&apos;re billed while it runs.
      </p>
      <div className="form-grid">
        <label>COMFYUI ADDRESS
          <input className="field" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://<pod-id>-8188.proxy.runpod.net" spellCheck={false} />
        </label>
        <label>AUTHORIZATION HEADER (OPTIONAL)
          <input className="field" type="password" value={auth} onChange={e => setAuth(e.target.value)} autoComplete="off"
            placeholder={status?.hasAuth ? "Saved (leave empty to keep)" : "Only if your ComfyUI sits behind a login, e.g. Bearer …"} />
        </label>
      </div>
      {status?.source === "env" && <p className="muted small">Currently using COMFYUI_URL from .env.local. Saving here overrides it.</p>}
      <div className="button-row">
        <button className="button primary" disabled={!!busy || !url.trim()} onClick={() => void save({ url, authHeader: auth || undefined })}>{busy === "save" ? "Saving…" : "Save address"}</button>
        <button className="button secondary" disabled={!!busy || !status?.url} onClick={() => void check()}>{busy === "check" ? "Testing…" : "Test connection"}</button>
        {status?.hasAuth && <button className="tiny-button" disabled={!!busy} onClick={() => void save({ url, clearAuth: true })}>Remove auth header</button>}
        {status?.source === "settings" && <button className="tiny-button" disabled={!!busy} onClick={() => { if (confirm("Disconnect ComfyUI?")) void save({ url: "" }); }}>Disconnect</button>}
      </div>
      {error && <p className="error-text small">{error}</p>}
      {c && !c.ok && <p className="error-text small">{c.error}</p>}
      {c?.ok && (
        <div className="comfy-check">
          <p className="small"><strong>{c.gpu ?? "GPU"}</strong>{c.vramTotalGb ? ` · ${c.vramTotalGb} GB VRAM (${c.vramFreeGb ?? "?"} GB free)` : ""}{c.comfyVersion ? ` · ComfyUI ${c.comfyVersion}` : ""}</p>
          {(c.workflows ?? []).map(w => (
            <div key={w.id} className="comfy-workflow">
              <b>{w.ready ? "✓" : "✗"} {w.label}</b>
              <ul>
                {w.files.map(f => (
                  <li key={f.folder + f.name} className={f.present ? "" : "warn-text"}>
                    {f.present ? "✓" : "missing"} · <code>models/{f.folder}/{f.name}</code>{f.optional ? ` (optional: ${f.optional})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {script && <>
            <span className="field-label">DOWNLOAD THE MISSING MODELS (RUN IN THE COMFYUI FOLDER ON THE POD, E.G. VIA ITS WEB TERMINAL)</span>
            <pre className="code-block">{script}</pre>
            <div className="button-row"><button className="tiny-button" onClick={() => { void navigator.clipboard?.writeText(script); notify("Commands copied."); }}>Copy commands</button></div>
            <p className="muted small">Then refresh ComfyUI (or restart it) and press Test connection again. Models are tens of GB; keep them on a RunPod network volume so you download them once.</p>
          </>}
        </div>
      )}
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
      <ComfyPanel />
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
