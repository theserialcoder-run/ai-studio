"use client";
// Client-side workspace state: project list, the open project, and saving.
//
// The open project is edited in memory through `mutate(recipe)`, which applies
// the recipe to a clone, logs optional activity, and schedules a debounced PUT.
// Saves are serialized and carry the last known revision; a 409 response puts
// the workspace in "conflict" state until the user reloads.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { migrateLegacyProject } from "./legacy";
import { logActivity, nowIso, summarize } from "../projectModel";
import type { Asset, Project, ProjectSummary } from "../types";

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";
export type Recipe = (draft: Project) => void;

const ACTIVE_KEY = "wonderboy-active-project";
const SAVE_DELAY_MS = 700;

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* storage unavailable */ }
}
function recalled(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

// Shared across effect re-runs (React Strict Mode mounts twice in dev) so the
// first-run import/starter creation can only happen once per page load.
let bootstrapOnce: Promise<{ list: ProjectSummary[]; initial: Project | null }> | null = null;

async function bootstrap() {
  const { projects, firstRun } = await api.list();
  let initial: Project | null = null;
  if (firstRun && projects.length === 0) {
    initial = (await migrateLegacyProject())
      ?? (await api.create({ name: "The Disturbance", logline: "A quiet man begins to notice small disturbances in his ordinary routine.", starter: true }));
  }
  return { list: initial ? (await api.list()).projects : projects, initial };
}

export function useWorkspace() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveStateRaw] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");

  const projectRef = useRef<Project | null>(null);
  const revisions = useRef(new Map<string, number>());
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveStateRef = useRef<SaveState>("idle");

  const setSaveState = (s: SaveState) => { saveStateRef.current = s; setSaveStateRaw(s); };

  const adopt = useCallback((p: Project | null) => {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    projectRef.current = p;
    setProject(p);
    setSaveState("idle");
    setSaveError("");
    if (p) revisions.current.set(p.id, p.revision);
    remember(p?.id ?? null);
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    while (saving.current) await saving.current;
    const p = projectRef.current;
    if (!p || !dirty.current) return true;
    if (saveStateRef.current === "conflict") return false;
    dirty.current = false;
    setSaveState("saving");
    const run = (async () => {
      try {
        const res = await api.save(p, revisions.current.get(p.id) ?? p.revision);
        revisions.current.set(p.id, res.revision);
        setProjects(list => list.map(x => (x.id === p.id ? summarize({ ...p, updatedAt: res.updatedAt }) : x)));
        if (!dirty.current) setSaveState("saved");
      } catch (e) {
        dirty.current = true;
        if (e instanceof ApiError && e.status === 409) setSaveState("conflict");
        else setSaveState("error");
        setSaveError(e instanceof Error ? e.message : "Could not save");
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
    if (dirty.current && saveStateRef.current === "saving") scheduleSave();
    return !dirty.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, SAVE_DELAY_MS);
  }, [saveNow]);

  /** Apply an edit to the open project. `activity` is logged to the project's recent activity. */
  const mutate = useCallback((recipe: Recipe, activity?: string) => {
    const current = projectRef.current;
    if (!current) return;
    const draft = structuredClone(current);
    recipe(draft);
    if (activity) logActivity(draft, activity);
    draft.updatedAt = nowIso();
    projectRef.current = draft;
    setProject(draft);
    dirty.current = true;
    if (saveStateRef.current !== "conflict") {
      if (saveStateRef.current === "error") setSaveState("saving");
      scheduleSave();
    }
  }, [scheduleSave]);

  const openProject = useCallback(async (id: string) => {
    await saveNow();
    try {
      adopt(await api.get(id));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not open project");
    }
  }, [adopt, saveNow]);

  const refreshList = useCallback(async () => {
    const { projects: list } = await api.list();
    setProjects(list);
    return list;
  }, []);

  // Initial load (+ first-run import / starter project).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        bootstrapOnce ??= bootstrap().catch(e => { bootstrapOnce = null; throw e; });
        const { list: finalList, initial } = await bootstrapOnce;
        if (cancelled) return;
        setProjects(finalList);
        const wanted = initial?.id ?? recalled();
        const pick = finalList.find(p => p.id === wanted) ?? finalList[0];
        if (initial && pick?.id === initial.id) adopt(initial);
        else if (pick) adopt(await api.get(pick.id));
        else adopt(null);
        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Could not load projects");
        setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [adopt]);

  // Try to flush on tab close, and warn if something is unsaved.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const p = projectRef.current;
      if (!p || (!dirty.current && !saving.current)) return;
      if (dirty.current && saveStateRef.current !== "conflict") {
        const rev = revisions.current.get(p.id) ?? p.revision;
        if (JSON.stringify(p).length < 60_000) void api.save(p, rev, true).catch(() => {});
      }
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const createProject = useCallback(async (input: { name: string; logline?: string; style?: string }) => {
    await saveNow();
    const created = await api.create(input);
    setProjects(list => [summarize(created), ...list]);
    adopt(created);
    return created;
  }, [adopt, saveNow]);

  const deleteProject = useCallback(async (id: string) => {
    if (projectRef.current?.id === id) {
      if (timer.current) clearTimeout(timer.current);
      dirty.current = false;
      while (saving.current) await saving.current;
    }
    await api.remove(id);
    revisions.current.delete(id);
    const list = await refreshList();
    if (projectRef.current?.id === id) {
      if (list[0]) adopt(await api.get(list[0].id));
      else adopt(null);
    }
  }, [adopt, refreshList]);

  const renameProject = useCallback(async (id: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    if (projectRef.current?.id === id) {
      mutate(d => { d.name = clean; }, `Renamed project to “${clean}”`);
      return;
    }
    const p = await api.get(id);
    p.name = clean;
    logActivity(p, `Renamed project to “${clean}”`);
    await api.save(p, p.revision);
    await refreshList();
  }, [mutate, refreshList]);

  /** Discard local changes and load the stored version (used after a conflict). */
  const reloadProject = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    adopt(await api.get(p.id));
  }, [adopt]);

  /**
   * Upload files to the open project, add their asset records, and optionally
   * link them in the same edit (e.g. to a character's references).
   */
  const uploadFiles = useCallback(async (files: File[], link?: (draft: Project, assets: Asset[]) => void, activity?: string): Promise<Asset[]> => {
    const p = projectRef.current;
    if (!p || files.length === 0) return [];
    const assets = await api.upload(p.id, files);
    if (projectRef.current?.id !== p.id) return assets; // user switched projects mid-upload
    mutate(d => {
      d.assets.push(...assets);
      link?.(d, assets);
    }, activity ?? `Uploaded ${assets.length === 1 ? `“${assets[0].name}”` : `${assets.length} files`}`);
    return assets;
  }, [mutate]);

  return {
    projects, project, status, loadError, saveState, saveError,
    mutate, saveNow, openProject, createProject, deleteProject, renameProject, reloadProject, uploadFiles,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
