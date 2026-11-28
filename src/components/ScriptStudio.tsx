"use client";
import { useState } from "react";
import {
  makeScene, makeScript, moveWithinGroup, parseScenesFromScreenplay, removeScene, removeScript, sceneNumber, scenesOf, shotsOf,
} from "@/lib/projectModel";
import type { ID, Project, Scene } from "@/lib/types";
import { Dropdown } from "./Dropdown";
import { ScriptAssistant } from "./ScriptAssistant";
import { EmptyState, RowActions, TextField, useStudio } from "./studio";

export function ScriptStudio() {
  const { ws, project, go, notify, setFocusSceneId } = useStudio();
  const [scriptId, setScriptId] = useState<ID>(project.scripts[0]?.id ?? "");
  const [openScene, setOpenScene] = useState<ID | null>(null);
  const script = project.scripts.find(s => s.id === scriptId) ?? project.scripts[0];

  if (!script) {
    return <div className="content"><EmptyState>No scripts. <button className="text-button" onClick={addScript}>Create one</button></EmptyState></div>;
  }
  const scenes = scenesOf(project, script.id);
  const words = script.content.trim().split(/\s+/).filter(Boolean).length;

  function addScript() {
    const s = makeScript({ title: `Script ${project.scripts.length + 1}` });
    ws.mutate(d => { d.scripts.push(s); }, `Created script “${s.title}”`);
    setScriptId(s.id);
  }

  function editScript(patch: { title?: string; content?: string }) {
    ws.mutate(d => {
      const s = d.scripts.find(x => x.id === script.id);
      if (s) Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    }, `Edited script “${patch.title ?? script.title}”`);
  }

  function addScene() {
    const scene = makeScene(script.id, { heading: "INT. ", title: "" });
    ws.mutate(d => { d.scenes.push(scene); }, `Added scene to “${script.title}”`);
    setOpenScene(scene.id);
  }

  function importScenes() {
    const parsed = parseScenesFromScreenplay(script.content);
    if (parsed.length === 0) { notify("No sluglines found. Scene headings must start with INT. or EXT."); return; }
    const existing = new Set(scenes.map(s => s.heading.trim().toUpperCase()));
    const fresh = parsed.filter(p => !existing.has(p.heading.toUpperCase()));
    if (fresh.length === 0) { notify("All scene headings in the screenplay already exist as scenes."); return; }
    ws.mutate(d => { for (const p of fresh) d.scenes.push(makeScene(script.id, { heading: p.heading, dialogue: p.body })); },
      `Created ${fresh.length} scene${fresh.length === 1 ? "" : "s"} from the screenplay`);
    notify(`Created ${fresh.length} scene${fresh.length === 1 ? "" : "s"} from sluglines.`);
  }

  return (
    <div className="content">
      <div className="section-head">
        <div><span className="eyebrow">WRITE THE FILM</span><h3>Script studio</h3><p>Write the screenplay, then organise it into scenes with characters and locations.</p></div>
        <button className="button secondary" onClick={() => go("AI Companion")}>Ask AI for help ↗</button>
      </div>

      <div className="script-layout">
        <aside className="panel script-list">
          <div className="panel-head"><h3>Scripts</h3><button className="text-button" onClick={addScript}>+ New</button></div>
          {project.scripts.map(s => (
            <button key={s.id} className={`list-item${s.id === script.id ? " active" : ""}`} onClick={() => setScriptId(s.id)}>
              <strong>{s.title || "Untitled script"}</strong>
              <small>{scenesOf(project, s.id).length} scenes · {s.content.trim().split(/\s+/).filter(Boolean).length} words</small>
            </button>
          ))}
        </aside>

        <div className="script-main">
          <div className="panel">
            <label>SCRIPT TITLE<input className="field" value={script.title} onChange={e => editScript({ title: e.target.value })} /></label>
            <label>SCREENPLAY
              <textarea className="field script-editor" value={script.content} onChange={e => editScript({ content: e.target.value })}
                placeholder={"FADE IN:\n\nINT. ROOM - MORNING\n\nWrite your scene here..."} />
            </label>
            <div className="editor-footer">
              <span className="muted">{words} words · saved to this project</span>
              <span className="button-row">
                <button className="button secondary" onClick={importScenes}>Create scenes from sluglines</button>
                {project.scripts.length > 1 && (
                  <button className="tiny-button danger-text" onClick={() => {
                    if (!confirm(`Delete “${script.title}” and its ${scenes.length} scenes? Their shots are kept as unassigned shots.`)) return;
                    ws.mutate(d => removeScript(d, script.id), `Deleted script “${script.title}”`);
                    setScriptId(project.scripts.find(s => s.id !== script.id)!.id);
                  }}>Delete script</button>
                )}
              </span>
            </div>
          </div>

          <ScriptAssistant key={script.id} scriptId={script.id} />

          <div className="panel">
            <div className="panel-head"><div><h3>Scenes</h3><p className="muted">Scene order is the order below.</p></div><button className="button primary" onClick={addScene}>Add scene +</button></div>
            {scenes.length === 0 && <EmptyState>No scenes yet. Add one, or write sluglines (INT./EXT.) in the screenplay and use “Create scenes from sluglines”.</EmptyState>}
            <div className="stack">
              {scenes.map(scene => (
                <SceneRow key={scene.id} project={project} scene={scene} open={openScene === scene.id}
                  onToggle={() => setOpenScene(openScene === scene.id ? null : scene.id)}
                  onPlanShots={() => { setFocusSceneId(scene.id); go("Shots"); }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SceneRow({ project, scene, open, onToggle, onPlanShots }: { project: Project; scene: Scene; open: boolean; onToggle: () => void; onPlanShots: () => void }) {
  const { ws } = useStudio();
  const n = sceneNumber(project, scene.id);
  const label = `Scene ${n}`;
  const edit = (patch: Partial<Scene>) => ws.mutate(d => {
    const s = d.scenes.find(x => x.id === scene.id);
    if (s) Object.assign(s, patch, { updatedAt: new Date().toISOString() });
  }, `Edited ${label}${scene.heading ? ` (${scene.heading})` : ""}`);
  const shotCount = shotsOf(project, scene.id).length;
  const loc = project.locations.find(l => l.id === scene.locationId);

  return (
    <div className={`item-card${open ? " open" : ""}`}>
      <div className="item-card-head">
        <button className="item-card-title" onClick={onToggle} aria-expanded={open}>
          <b className="item-number">{String(n).padStart(2, "0")}</b>
          <span>
            <strong>{scene.heading || scene.title || "Untitled scene"}</strong>
            <small>{[scene.title && scene.heading ? scene.title : "", loc?.name, scene.characterIds.length ? `${scene.characterIds.length} characters` : "", `${shotCount} shots`].filter(Boolean).join(" · ")}</small>
          </span>
        </button>
        <RowActions
          onUp={() => ws.mutate(d => moveWithinGroup(d.scenes, scene.id, -1, s => s.scriptId === scene.scriptId), `Reordered scenes`)}
          onDown={() => ws.mutate(d => moveWithinGroup(d.scenes, scene.id, 1, s => s.scriptId === scene.scriptId), `Reordered scenes`)}
          onDelete={() => { if (confirm(`Delete ${label}? Its ${shotCount} shots are kept as unassigned shots.`)) ws.mutate(d => removeScene(d, scene.id), `Deleted ${label}`); }}
        />
      </div>
      {open && (
        <div className="item-card-body">
          <div className="form-grid">
            <TextField label="SCENE HEADING (SLUGLINE)" value={scene.heading} onChange={v => edit({ heading: v })} placeholder="INT. KITCHEN - NIGHT" />
            <TextField label="TITLE" value={scene.title} onChange={v => edit({ title: v })} placeholder="Short name for this scene" />
          </div>
          <TextField label="DESCRIPTION" multiline value={scene.description} onChange={v => edit({ description: v })} placeholder="What happens in this scene, its purpose, emotional beat…" />
          <TextField label="DIALOGUE & ACTION" multiline rows={8} mono value={scene.dialogue} onChange={v => edit({ dialogue: v })} placeholder={"RAMESH\nDid you hear that?"} />
          <div className="form-grid">
            <div>
              <span className="field-label">CHARACTERS IN SCENE</span>
              {project.characters.length === 0
                ? <p className="muted small">No characters yet — add them in the Characters library.</p>
                : <div className="chip-select">{project.characters.map(c => {
                    const on = scene.characterIds.includes(c.id);
                    return <button key={c.id} type="button" className={`chip${on ? " on" : ""}`}
                      onClick={() => edit({ characterIds: on ? scene.characterIds.filter(x => x !== c.id) : [...scene.characterIds, c.id] })}>{c.name}</button>;
                  })}</div>}
            </div>
            <label>LOCATION
              <Dropdown value={scene.locationId ?? ""} onChange={v => edit({ locationId: v || null })}
                options={[{ value: "", label: "— None —" }, ...project.locations.map(l => ({ value: l.id, label: l.name }))]} />
            </label>
          </div>
          <div className="button-row"><button className="button secondary" onClick={onPlanShots}>Plan shots for this scene ↗</button></div>
        </div>
      )}
    </div>
  );
}
