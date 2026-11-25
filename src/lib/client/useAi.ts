"use client";
// Provider registry + generation history for the open project. Finished jobs
// are imported into the project (assets + shot takes) exactly once.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProvidersResponse } from "../ai/types";
import { shotNumber } from "../projectModel";
import { aiApi, type GenerationView } from "./ai";
import type { Workspace } from "./useWorkspace";

export function useAi(ws: Workspace) {
  const projectId = ws.project?.id ?? null;
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [providersError, setProvidersError] = useState("");
  const [generations, setGenerations] = useState<GenerationView[]>([]);
  const importing = useRef(new Set<string>());

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await aiApi.providers());
      setProvidersError("");
    } catch (e) {
      setProvidersError(e instanceof Error ? e.message : "Could not load providers");
    }
  }, []);
  useEffect(() => { void refreshProviders(); }, [refreshProviders]);

  const refreshGenerations = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await aiApi.generations(projectId);
      setGenerations(list);
    } catch { /* keep last known list */ }
  }, [projectId]);

  // Load on project change; poll every 3 s while any job is running.
  useEffect(() => {
    setGenerations([]);
    importing.current.clear();
    void refreshGenerations();
  }, [refreshGenerations]);
  const running = generations.some(g => g.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void refreshGenerations(); }, 3000);
    return () => clearInterval(t);
  }, [running, refreshGenerations]);

  // Import finished outputs into the project document.
  const project = ws.project;
  const { mutate } = ws;
  useEffect(() => {
    if (!project) return;
    const pending = generations.filter(g => g.status === "succeeded" && g.outputs.length && !project.importedGenerationIds.includes(g.id) && !importing.current.has(g.id));
    if (!pending.length) return;
    pending.forEach(g => importing.current.add(g.id));
    for (const g of pending) {
      const shot = project.shots.find(s => s.id === g.shotId);
      mutate(d => {
        for (const o of g.outputs) if (!d.assets.some(a => a.id === o.id)) d.assets.push(o);
        const s = d.shots.find(x => x.id === g.shotId);
        if (s) for (const o of g.outputs) if (!s.generatedAssetIds.includes(o.id)) s.generatedAssetIds.push(o.id);
        if (!d.importedGenerationIds.includes(g.id)) d.importedGenerationIds.push(g.id);
      }, `Generated ${g.type === "audio" ? "voiceover" : g.outputs.length > 1 ? `${g.outputs.length} ${g.type}s` : `a ${g.type}`} with ${g.providerLabel}${shot ? ` for shot ${shotNumber(project, shot)}` : ""}`);
    }
  }, [generations, project, mutate]);

  return { providers, providersError, refreshProviders, generations, refreshGenerations };
}

export type AiState = ReturnType<typeof useAi>;
