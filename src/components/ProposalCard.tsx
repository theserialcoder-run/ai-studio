"use client";
import { useState } from "react";
import { logActivity } from "@/lib/projectModel";
import { applyProposal, type Proposal } from "@/lib/proposals";
import type { ID } from "@/lib/types";
import { useStudio } from "./studio";

const TITLES: Record<Proposal["kind"], string> = {
  text: "Notes", logline: "Logline options", script: "Script draft", scenes: "Scene breakdown", scene_update: "Scene revision",
  shots: "Shot list", characters: "New characters", locations: "New locations",
};

function Field({ label, value }: { label: string; value: string }) {
  return value ? <div className="pv-field"><span>{label}</span><p>{value}</p></div> : null;
}

/** Shows an AI proposal for review. Nothing changes until the user clicks an apply button. */
export function ProposalCard({ proposal, targetScriptId, targetSceneId }: { proposal: Proposal; targetScriptId?: ID | null; targetSceneId?: ID | null }) {
  const { ws, project, notify } = useStudio();
  const [applied, setApplied] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [choice, setChoice] = useState(0);

  function apply(opts: { replace?: boolean } = {}, p: Proposal = proposal) {
    let summary = "";
    ws.mutate(d => {
      summary = applyProposal(d, p, { ...opts, scriptId: targetScriptId, sceneId: targetSceneId });
      logActivity(d, summary);
    });
    setApplied(summary);
    notify(summary);
  }

  const p = proposal;
  const replaceTarget = p.kind === "script" && p.replaceScriptId ? project.scripts.find(s => s.id === p.replaceScriptId) : undefined;
  const sceneTarget = p.kind === "scene_update" ? project.scenes.find(s => s.id === p.sceneId) : undefined;
  const shotScene = p.kind === "shots" ? project.scenes.find(s => s.id === (p.sceneId ?? targetSceneId)) : undefined;

  return (
    <div className={`proposal${applied ? " applied" : ""}`}>
      <div className="proposal-head">
        <button className="proposal-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <span className="eyebrow gold">AI SUGGESTION · REVIEW BEFORE APPLYING</span>
          <strong>{TITLES[p.kind]}{p.kind === "script" || p.kind === "text" ? ` — ${p.title}` : ""}</strong>
        </button>
        {applied && <span className="badge">Applied</span>}
      </div>
      {open && (
        <div className="proposal-body">
          {p.kind === "text" && <pre className="pv-pre">{p.body}</pre>}
          {p.kind === "logline" && (
            <div className="stack tight">
              {p.options.map((o, i) => (
                <label key={i} className="check"><input type="radio" name={`ll-${o.slice(0, 8)}`} checked={choice === i} onChange={() => setChoice(i)} /><span>{o}</span></label>
              ))}
            </div>
          )}
          {p.kind === "script" && <pre className="pv-pre">{p.content}</pre>}
          {p.kind === "scenes" && p.scenes.map((s, i) => (
            <div key={i} className="pv-item">
              <strong>{s.heading || s.title}</strong>
              <Field label="Title" value={s.heading ? s.title : ""} /><Field label="Description" value={s.description} />
              <Field label="Characters" value={s.characterNames.join(", ")} /><Field label="Location" value={s.locationName} />
              {s.dialogue && <pre className="pv-pre small-pre">{s.dialogue}</pre>}
            </div>
          ))}
          {p.kind === "scene_update" && (
            <div className="pv-item">
              <strong>{sceneTarget ? sceneTarget.heading || sceneTarget.title : "Scene"}</strong>
              {(["heading", "title", "description", "dialogue"] as const).map(k => p.patch[k] !== undefined && (
                <div key={k} className="pv-diff">
                  <span>{k.toUpperCase()}</span>
                  <div><em>Current</em><pre className="pv-pre small-pre">{sceneTarget?.[k] || "—"}</pre></div>
                  <div><em>Suggested</em><pre className="pv-pre small-pre">{p.patch[k]}</pre></div>
                </div>
              ))}
            </div>
          )}
          {p.kind === "shots" && (
            <>
              <p className="muted small">Target: {shotScene ? shotScene.heading || shotScene.title : "Unassigned shots"}</p>
              {p.shots.map((s, i) => (
                <div key={i} className="pv-item">
                  <strong>{i + 1}. {s.title}</strong>
                  <p className="small">{s.description}</p>
                  <div className="meta-row">{[s.framing, s.cameraAngle, s.cameraMovement, s.lighting, s.mood, s.durationSec ? `${s.durationSec}s` : "", s.characterNames.join(", "), s.locationName].filter(Boolean).map((x, j) => <span key={j}>{x}</span>)}</div>
                </div>
              ))}
            </>
          )}
          {p.kind === "characters" && p.characters.map((c, i) => (
            <div key={i} className="pv-item"><strong>{c.name}</strong><Field label="Description" value={c.description} /><Field label="Appearance" value={c.appearance} /><Field label="Clothing" value={c.clothing} /><Field label="Personality" value={c.personality} /></div>
          ))}
          {p.kind === "locations" && p.locations.map((l, i) => (
            <div key={i} className="pv-item"><strong>{l.name}</strong><Field label="Description" value={l.description} /><Field label="Architecture" value={l.architecture} /><Field label="Layout" value={l.layout} /><Field label="Lighting" value={l.lighting} /><Field label="Fixed details" value={l.visualDetails} /></div>
          ))}

          {!applied && (
            <div className="button-row">
              {p.kind === "script" ? (
                <>
                  <button className="button primary" onClick={() => apply({ replace: false })}>Add as new script</button>
                  {replaceTarget && (
                    <button className="button secondary danger-text" onClick={() => {
                      if (confirm(`Replace the text of “${replaceTarget.title}” with this AI version? The current text will be overwritten (export the project first if you want a backup).`)) apply({ replace: true });
                    }}>Replace “{replaceTarget.title}”…</button>
                  )}
                </>
              ) : p.kind === "scene_update" ? (
                <button className="button primary" disabled={!sceneTarget} onClick={() => { if (confirm("Apply these changes to the scene? The current text of the changed fields will be replaced.")) apply(); }}>Apply to scene…</button>
              ) : p.kind === "logline" ? (
                <button className="button primary" onClick={() => {
                  if (project.logline && !confirm(`Replace the current logline?\n\n“${project.logline}”`)) return;
                  apply({}, { kind: "logline", options: [p.options[choice]] });
                }}>Use selected logline</button>
              ) : (
                <button className="button primary" onClick={() => apply()}>{p.kind === "text" ? "Save as new script" : "Add to project"}</button>
              )}
              {(p.kind === "text" || p.kind === "script") && (
                <button className="button secondary" onClick={() => navigator.clipboard.writeText(p.kind === "text" ? p.body : p.content).then(() => notify("Copied."))}>Copy</button>
              )}
            </div>
          )}
          {applied && <p className="muted small">{applied}</p>}
        </div>
      )}
    </div>
  );
}
