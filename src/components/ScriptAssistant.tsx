"use client";
import { useState } from "react";
import { aiApi } from "@/lib/client/ai";
import { sceneLabel, scenesOf } from "@/lib/projectModel";
import type { Proposal } from "@/lib/proposals";
import type { ID } from "@/lib/types";
import { Dropdown } from "./Dropdown";
import { ProposalCard } from "./ProposalCard";
import { useStudio } from "./studio";

const TASKS: { id: string; label: string; scene?: boolean }[] = [
  { id: "ideas", label: "Story ideas" },
  { id: "logline", label: "Loglines" },
  { id: "outline", label: "Plot outline" },
  { id: "script", label: "Write a complete script (new)" },
  { id: "improve_script", label: "Improve this script" },
  { id: "breakdown", label: "Break this script into scenes" },
  { id: "rewrite_dialogue", label: "Rewrite scene dialogue", scene: true },
  { id: "improve_scene", label: "Improve scene", scene: true },
  { id: "shot_list", label: "Shot list for scene", scene: true },
  { id: "characters", label: "Suggest characters" },
  { id: "locations", label: "Suggest locations" },
];

interface Run { id: number; task: string; summary: string; proposals: Proposal[]; provider: string; sceneId: ID | null }

/** AI script assistant: produces proposals the user reviews and applies. */
export function ScriptAssistant({ scriptId }: { scriptId: ID }) {
  const { ws, project, ai, go } = useStudio();
  const [task, setTask] = useState("ideas");
  const [sceneId, setSceneId] = useState<ID | "">("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const def = TASKS.find(t => t.id === task)!;
  const scenes = scenesOf(project, scriptId);
  const ready = !!ai.providers?.activeLlm;

  async function run() {
    if (def.scene && !sceneId) { setError("Choose a scene for this task."); return; }
    setBusy(true);
    setError("");
    try {
      await ws.saveNow();
      const res = await aiApi.assist(project.id, task, instructions, { scriptId, sceneId: def.scene ? sceneId : null });
      setRuns(r => [{ id: Date.now(), task: def.label, summary: res.summary, proposals: res.proposals, provider: res.provider, sceneId: sceneId || null }, ...r].slice(0, 5));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The assistant failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head"><div><h3>AI script assistant</h3><p className="muted">Suggestions are never applied automatically — review each one first.</p></div></div>
      {!ready && ai.providers && <div className="setup-note"><strong>No text AI provider configured.</strong> <button className="text-button" onClick={() => go("Settings")}>Set one up ↗</button></div>}
      <div className="form-grid">
        <label>TASK
          <Dropdown value={task} onChange={v => setTask(v)} options={TASKS.map(t => ({ value: t.id, label: t.label }))} />
        </label>
        <label>SCENE
          <Dropdown value={sceneId} disabled={!def.scene} onChange={v => setSceneId(v)}
            options={[{ value: "", label: def.scene ? "— choose a scene —" : "Not needed for this task" }, ...scenes.map(s => ({ value: s.id, label: sceneLabel(project, s) }))]} />
        </label>
      </div>
      <label>INSTRUCTIONS (OPTIONAL)
        <textarea className="field textarea-small" value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="Tone, genre, length, what to keep or change…" />
      </label>
      <div className="button-row">
        <button className="button primary" disabled={busy || !ready} onClick={run}>{busy ? "Working…" : "Ask the assistant ↗"}</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="stack">
        {runs.map(r => (
          <div key={r.id} className="assist-run">
            <p className="muted small">{r.task} · {r.provider}{r.summary ? ` — ${r.summary}` : ""}</p>
            {r.proposals.map((p, i) => <ProposalCard key={i} proposal={p} targetScriptId={scriptId} targetSceneId={r.sceneId} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
