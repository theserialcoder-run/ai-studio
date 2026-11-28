"use client";

import { useCallback, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/client/useWorkspace";
import { useAi } from "@/lib/client/useAi";
import type { ID } from "@/lib/types";
import { AssetLibrary } from "@/components/AssetLibrary";
import { CharacterLibrary } from "@/components/CharacterLibrary";
import { CompanionView } from "@/components/CompanionView";
import { DashboardView } from "@/components/DashboardView";
import { GenerationStudio } from "@/components/GenerationStudio";
import { LocationLibrary } from "@/components/LocationLibrary";
import { ProjectsView } from "@/components/ProjectsView";
import { ScriptStudio } from "@/components/ScriptStudio";
import { SettingsView, exportProjectJson } from "@/components/SettingsView";
import { ShotPlanner } from "@/components/ShotPlanner";
import { StoryCutStudio } from "@/components/StoryCutStudio";
import { VoiceStudio } from "@/components/VoiceStudio";
import { Dropdown } from "@/components/Dropdown";
import { StudioContext, TABS, type StudioCtx, type Tab } from "@/components/studio";

const ICONS: Record<Tab, string> = {
  Overview: "◫", Projects: "▦", "AI Companion": "✳", Script: "≡", Shots: "▤", Characters: "◉", Locations: "⌂",
  Assets: "◈", "Image Studio": "▧", "Video Studio": "▷", "Voice Studio": "♪", "Story Cuts": "✂", Settings: "⚙",
};

export default function Home() {
  const ws = useWorkspace();
  const ai = useAi(ws);
  const [tab, setTab] = useState<Tab>("Overview");
  const [notice, setNotice] = useState("Workspace · projects are saved on this computer");
  const [focusShotId, setFocusShotId] = useState<ID | null>(null);
  const [focusSceneId, setFocusSceneId] = useState<ID | null>(null);
  const [pendingSourceId, setPendingSourceId] = useState<ID | null>(null);

  const go = useCallback((t: Tab) => setTab(t), []);
  const project = ws.project;

  const ctx = useMemo<StudioCtx | null>(() => project ? {
    ws, ai, project, notify: setNotice, go, focusShotId, setFocusShotId, focusSceneId, setFocusSceneId, pendingSourceId, setPendingSourceId,
  } : null, [ws, ai, project, go, focusShotId, focusSceneId, pendingSourceId]);

  // Without an open project only the Projects view is usable.
  const view: Tab = project ? tab : "Projects";

  const saveLabel = {
    idle: "● Saved", saved: "● Saved", saving: "● Saving…", error: "● Not saved", conflict: "● Conflict",
  }[ws.saveState];

  async function switchProject(id: string) {
    if (!id || id === project?.id) return;
    await ws.openProject(id);
    setFocusShotId(null);
    setFocusSceneId(null);
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">W</span><div><b>WONDERBOY</b><small>AI FILM STUDIO</small></div></div>
        <div className="workspace-label">PROJECT</div>
        <Dropdown className="project-switcher" ariaLabel="Switch project" value={project?.id ?? ""} placeholder="No project open"
          leading={<span className="dot" />} disabled={ws.status !== "ready"} onChange={id => void switchProject(id)}
          options={ws.projects.map(p => ({
            value: p.id,
            label: (p.id === project?.id ? project.name : p.name) || "Untitled film",
            hint: `${p.counts.scenes} scene${p.counts.scenes === 1 ? "" : "s"} · ${p.counts.shots} shot${p.counts.shots === 1 ? "" : "s"} · ${p.counts.assets} file${p.counts.assets === 1 ? "" : "s"}`,
          }))} />
        <nav>
          {TABS.map(n => (
            <button key={n} className={view === n ? "nav-item active" : "nav-item"} onClick={() => setTab(n)} disabled={!project && n !== "Projects"}>
              <span className="nav-icon">{ICONS[n]}</span>{n}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom"><div className="status-dot" /> Saved on this computer <small>{ws.projects.length} project{ws.projects.length === 1 ? "" : "s"} · provider connections optional</small></div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div><span className="eyebrow">{project ? project.name.toUpperCase() : "YOUR CREATIVE WORKSPACE"}</span><h1>{view}</h1></div>
          <div className="top-actions">
            {project && <span className={`save-state ${ws.saveState}`} title={ws.saveError || undefined}>{saveLabel}</span>}
            {project && <button className="button secondary" onClick={() => exportProjectJson(project)}>Export project</button>}
          </div>
        </header>

        {(ws.saveState === "conflict" || ws.saveState === "error") && (
          <div className={`banner ${ws.saveState}`}>
            <span>{ws.saveError || "Changes could not be saved."}</span>
            {ws.saveState === "error"
              ? <button className="button secondary" onClick={() => void ws.saveNow()}>Retry save</button>
              : <button className="button secondary" onClick={() => { if (confirm("Reload the saved version? Your unsaved changes in this tab will be lost.")) void ws.reloadProject(); }}>Reload project</button>}
          </div>
        )}

        {ws.status === "loading" && <div className="content"><p className="muted">Loading your workspace…</p></div>}
        {ws.status === "error" && <div className="content"><div className="empty-state">Could not load projects: {ws.loadError}. Check that the dev server is running, then refresh.</div></div>}

        {ws.status === "ready" && view === "Projects" && <ProjectsView ws={ws} notify={setNotice} onOpened={() => setTab("Overview")} />}

        {ws.status === "ready" && ctx && (
          <StudioContext.Provider value={ctx}>
            {view === "Overview" && <DashboardView />}
            {view === "AI Companion" && <CompanionView key={ctx.project.id} />}
            {view === "Script" && <ScriptStudio key={ctx.project.id} />}
            {view === "Shots" && <ShotPlanner key={ctx.project.id} />}
            {view === "Characters" && <CharacterLibrary key={ctx.project.id} />}
            {view === "Locations" && <LocationLibrary key={ctx.project.id} />}
            {view === "Assets" && <AssetLibrary key={ctx.project.id} />}
            {view === "Image Studio" && <GenerationStudio key={`img-${ctx.project.id}`} mode="image" />}
            {view === "Video Studio" && <GenerationStudio key={`vid-${ctx.project.id}`} mode="video" />}
            {view === "Voice Studio" && <VoiceStudio key={`voice-${ctx.project.id}`} />}
            {view === "Story Cuts" && <StoryCutStudio key={`story-${ctx.project.id}`} />}
            {view === "Settings" && <SettingsView />}
          </StudioContext.Provider>
        )}

        <footer className="footer"><span>WONDERBOY AI STUDIO · PRIVATE CREATIVE WORKSPACE</span><span>{notice}</span></footer>
      </section>
    </main>
  );
}
