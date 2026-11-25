"use client";
// Story Cut job list for the open project. Finished results (scenes, descriptions,
// rendered videos) are imported into the project document exactly once.
import { useCallback, useEffect, useRef, useState } from "react";
import { nowIso } from "../projectModel";
import type { StoryJobView } from "../storyCut";
import { aiApi } from "./ai";
import type { Workspace } from "./useWorkspace";

export function useStoryCuts(ws: Workspace) {
  const projectId = ws.project?.id ?? null;
  const [jobs, setJobs] = useState<StoryJobView[]>([]);
  const [tools, setTools] = useState<{ ok: boolean; error?: string } | null>(null);
  const importing = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await aiApi.storyJobs(projectId);
      setJobs(r.jobs);
      setTools(r.tools);
    } catch { /* keep the last known list */ }
  }, [projectId]);

  useEffect(() => { importing.current.clear(); void refresh(); }, [refresh]);
  const running = jobs.some(j => j.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [running, refresh]);

  const project = ws.project;
  const { mutate } = ws;
  useEffect(() => {
    if (!project) return;
    const hasResult = (j: StoryJobView) => !!(j.segments || j.output || j.lines || j.cast?.length || (j.descriptions && Object.keys(j.descriptions).length));
    // Failed jobs can carry partial results (e.g. scenes found before the AI hit a limit): keep those too.
    const ready = jobs.filter(j => j.status !== "running" && hasResult(j) && !project.importedGenerationIds.includes(j.id) && !importing.current.has(j.id));
    for (const j of ready) {
      importing.current.add(j.id);
      const label = j.kind === "detect" ? `Found ${j.segments?.length ?? 0} scenes`
        : j.kind === "describe" ? `Described ${Object.keys(j.descriptions ?? {}).length} scenes`
        : j.kind === "auto" ? (j.lines ? `Found clips for ${j.lines.length} script lines` : "Saved partial results")
        : "Rendered a video";
      mutate(d => {
        const cut = d.storyCuts.find(c => c.id === j.cutId);
        if (cut) {
          if (j.segments) {
            cut.segments = j.segments;
            // Script lines keep their text; their scene picks pointed at the old scenes.
            for (const l of cut.lines) { l.sceneId = null; l.options = []; }
          }
          if (j.descriptions) for (const s of cut.segments) if (j.descriptions[s.id]) s.description = j.descriptions[s.id];
          if (j.cast?.length) cut.cast = j.cast;
          if (j.lines) { cut.lines = j.lines; cut.mode = "script"; }
          if (j.output) {
            if (!d.assets.some(a => a.id === j.output!.id)) d.assets.push(j.output);
            if (!cut.outputAssetIds.includes(j.output.id)) cut.outputAssetIds.push(j.output.id);
          }
          cut.updatedAt = nowIso();
        } else if (j.output && !d.assets.some(a => a.id === j.output!.id)) {
          d.assets.push(j.output); // the cut was deleted; keep the video in the library
        }
        if (!d.importedGenerationIds.includes(j.id)) d.importedGenerationIds.push(j.id);
      }, `${label} for story cut “${j.cutTitle}”`);
    }
  }, [jobs, project, mutate]);

  return { jobs, tools, refresh };
}
