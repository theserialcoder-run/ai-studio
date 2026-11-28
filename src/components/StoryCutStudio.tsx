"use client";
// Story Cuts: tell a new, original story over existing footage (free stock clips,
// public-domain films). Footage → scenes → AI descriptions → AI story → voice + MP4.
import { useEffect, useState } from "react";
import { assetById, fileUrl, makeStoryCut, nowIso } from "@/lib/projectModel";
import { aiApi } from "@/lib/client/ai";
import { dropUnusedStock, useStoryCuts } from "@/lib/client/useStoryCuts";
import { STORY_STYLES, countWords, formatTime, linePiece, segmentLength, speakSeconds, styleById, wordBudget, type StoryJobView } from "@/lib/storyCut";
import { newId } from "@/lib/projectModel";
import type { ID, StoryCut, StoryCutLine, StoryCutSegment } from "@/lib/types";
import { Dropdown } from "./Dropdown";
import { EmptyState, Modal, UploadButton, useStudio } from "./studio";

const SENSITIVITY = [
  { value: 0.2, label: "Fewer scenes (only hard cuts)" },
  { value: 0.3, label: "Normal" },
  { value: 0.45, label: "More scenes" },
];
const KIND_LABEL: Record<StoryJobView["kind"], string> = { detect: "Scene detection", describe: "Scene descriptions", render: "Render", auto: "Find clips for my script", stock: "Find stock clips", check: "Check clips" };

/** "83", "1:23" or "1:02:03" → seconds; "" → null. */
function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some(n => !isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const frameUrl = (projectId: ID, name: string) => `/api/projects/${projectId}/storycuts/frames/${name}`;
/** The frame where a line's piece starts (extracted and cached by the server). */
const stillUrl = (projectId: ID, assetId: ID, time: number) => `/api/projects/${projectId}/storycuts/still?asset=${assetId}&t=${(Math.round(time * 10) / 10).toFixed(1)}`;
const FIT_LABEL = { good: "good fit", loose: "loose fit", poor: "poor fit" } as const;
const NUDGE = 0.5; // seconds per "earlier / later" click

export function StoryCutStudio() {
  const { ws, project, notify, ai } = useStudio();
  const { jobs, tools, refresh } = useStoryCuts(ws);
  const [selectedId, setSelectedId] = useState<ID | null>(project.storyCuts[0]?.id ?? null);
  const [busy, setBusy] = useState("");
  const [sensitivity, setSensitivity] = useState(0.3);
  const [overwriteDescriptions, setOverwriteDescriptions] = useState(false);
  const [previewId, setPreviewId] = useState<ID | null>(null);
  const [addId, setAddId] = useState("");
  const [pickLineId, setPickLineId] = useState<ID | null>(null);
  const [rescan, setRescan] = useState(false);
  const [lineQuery, setLineQuery] = useState<Record<ID, string>>({});
  // Ticks once a second while a job runs, so elapsed times stay live.
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = jobs.some(j => j.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const cut = project.storyCuts.find(c => c.id === selectedId) ?? project.storyCuts[0] ?? null;
  const audioProviders = ai.providers?.audio ?? [];
  const videoAssets = project.assets.filter(a => a.kind === "video");
  const cutJobs = cut ? jobs.filter(j => j.cutId === cut.id) : [];
  const running = new Set(cutJobs.filter(j => j.status === "running").map(j => j.kind));

  function editCut(fn: (c: StoryCut) => void, activity?: string) {
    if (!cut) return;
    ws.mutate(d => { const c = d.storyCuts.find(x => x.id === cut.id); if (c) { fn(c); c.updatedAt = nowIso(); } }, activity);
  }
  function editSegment(segId: ID, fn: (s: StoryCutSegment) => void, activity = "Edited a story cut") {
    editCut(c => { const s = c.segments.find(x => x.id === segId); if (s) fn(s); }, activity);
  }

  function createCut() {
    const c = makeStoryCut({ title: `Story ${project.storyCuts.length + 1}` });
    ws.mutate(d => { d.storyCuts.push(c); }, `Created story cut “${c.title}”`);
    setSelectedId(c.id);
  }

  function deleteCut() {
    if (!cut || !confirm(`Delete the story cut “${cut.title}”? Rendered videos stay in the asset library.`)) return;
    ws.mutate(d => { d.storyCuts = d.storyCuts.filter(c => c.id !== cut.id); }, `Deleted story cut “${cut.title}”`);
    setSelectedId(null);
  }

  async function start(kind: StoryJobView["kind"], extra: { overwrite?: boolean; sensitivity?: number; rescan?: boolean; resume?: boolean } = {}) {
    if (!cut) return;
    setBusy(kind);
    try {
      await ws.saveNow(); // the server reads the saved project
      await aiApi.startStoryJob(project.id, { kind, cutId: cut.id, ...extra });
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function findClips() {
    if (!cut) return;
    if (cut.lines.length && !confirm("Find clips again? This replaces the current lines and clip choices (your script text stays).")) return;
    void start("auto", { sensitivity, rescan });
    setRescan(false);
  }

  /** A failed job can be resumed when it's the latest of its kind for this story and nothing else is running on it. */
  function canResume(j: StoryJobView): boolean {
    return j.status === "failed" && j.kind !== "stock" && cutJobs.find(x => x.kind === j.kind)?.id === j.id
      && !cutJobs.some(x => x.status === "running" && x.kind !== "render");
  }

  /**
   * Continue where a failed job stopped. Its partial results are already in the project (scenes, descriptions,
   * lines, checked clips), and each step skips work that's done: describing skips described scenes, "Find clips"
   * no longer rescans, checking skips checked lines, and rendering reuses recorded voice lines.
   */
  function resume(j: StoryJobView) {
    if (j.kind === "auto") void (j.lines?.length ? start("check", { resume: true }) : start("auto", { sensitivity }));
    else if (j.kind === "check") void start("check", { resume: true });
    else if (j.kind === "describe") void start("describe", { overwrite: false });
    else if (j.kind === "detect") void start("detect", { sensitivity });
    else if (j.kind === "render") void start("render");
  }

  function renderResume(j: StoryJobView) {
    if (!canResume(j)) return null;
    return <button className="button secondary" disabled={!!busy} onClick={() => resume(j)} title="Continue where it stopped; finished work is kept">Resume</button>;
  }

  function detect() {
    if (!cut) return;
    if (cut.segments.some(s => s.description.trim() || s.narration.trim())
      && !confirm("Detecting scenes again replaces the current scenes, descriptions and narration. Continue?")) return;
    void start("detect", { sensitivity });
  }

  async function writeStory() {
    if (!cut) return;
    if (cut.segments.some(s => s.narration.trim()) && !confirm("Replace the current narration with a newly written story?")) return;
    setBusy("story");
    try {
      await ws.saveNow();
      const r = await aiApi.writeStory(project.id, { cutId: cut.id, style: cut.style, instructions: cut.instructions });
      editCut(c => {
        if (r.title && /^(Story \d+|Untitled story)$/.test(c.title)) c.title = r.title;
        for (const s of c.segments) {
          if (s.id in r.narrations) s.narration = r.narrations[s.id];
          s.skip = r.skips.includes(s.id);
        }
      }, `Wrote the story for “${cut.title}” with ${r.provider}`);
      notify(r.summary ? `Story written: ${r.summary}` : "Story written. Read it through and edit anything that doesn't fit the pictures.");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function suggestCast() {
    if (!cut) return;
    if (cut.cast.length && !confirm("Replace the current cast with the AI's suggestion?")) return;
    setBusy("cast");
    try {
      await ws.saveNow();
      const r = await aiApi.suggestCast(project.id, cut.id);
      editCut(c => { c.cast = r.cast; }, `Suggested a cast for “${cut.title}” with ${r.provider}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function matchScript() {
    if (!cut) return;
    if (cut.lines.length && !confirm("Rebuild the timeline from the script? Your line edits and scene picks will be replaced.")) return;
    setBusy("match");
    try {
      await ws.saveNow();
      const r = await aiApi.matchScript(project.id, cut.id);
      editCut(c => { c.lines = r.lines; }, `Matched scenes to the script of “${cut.title}” with ${r.provider}`);
      notify(r.notes);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function editLine(lineId: ID, fn: (l: StoryCutLine) => void, activity = "Edited the script timeline") {
    editCut(c => { const l = c.lines.find(x => x.id === lineId); if (l) fn(l); }, activity);
  }

  function moveLine(index: number, dir: -1 | 1) {
    editCut(c => {
      const j = index + dir;
      if (j < 0 || j >= c.lines.length) return;
      [c.lines[index], c.lines[j]] = [c.lines[j], c.lines[index]];
    }, "Reordered script lines");
  }

  function findStock() {
    if (!cut) return;
    if (cut.lines.length && !confirm("Find stock clips again? Lines whose text and search are unchanged keep their clip; the rest are searched again.")) return;
    void start("stock");
  }

  /** Downloads another found clip for a line and puts it on the timeline. */
  async function chooseStock(lineId: ID, optionId: string) {
    if (!cut) return;
    setBusy(`line:${lineId}`);
    try {
      await ws.saveNow();
      const r = await aiApi.stockSwap(project.id, cut.id, lineId, optionId);
      ws.mutate(d => {
        const c = d.storyCuts.find(x => x.id === cut.id);
        const l = c?.lines.find(x => x.id === lineId);
        if (!c || !l) return;
        if (!d.assets.some(a => a.id === r.asset.id)) d.assets.push(r.asset);
        c.segments.push(r.segment);
        const old = l.sceneId;
        l.sceneId = r.segment.id;
        // Drop the replaced clip if no other line uses it.
        if (old && !c.lines.some(x => x.sceneId === old)) {
          const seg = c.segments.find(x => x.id === old);
          c.segments = c.segments.filter(x => x.id !== old);
          if (seg) dropUnusedStock(d, [seg.assetId]);
        }
        c.updatedAt = nowIso();
      }, "Swapped a stock clip");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function searchLine(lineId: ID, kind: "video" | "photo") {
    if (!cut) return;
    const query = (lineQuery[lineId] ?? cut.lines.find(l => l.id === lineId)?.query ?? "").trim();
    if (!query) { notify("Type what you want to see, e.g. “woman laughing in the rain”."); return; }
    setBusy(`line:${lineId}`);
    try {
      await ws.saveNow();
      const r = await aiApi.stockSearch(project.id, cut.id, lineId, query, kind);
      editLine(lineId, l => { l.stock = r.options; l.query = r.query; }, "Searched stock clips for a line");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function moveSegment(index: number, dir: -1 | 1) {
    editCut(c => {
      const j = index + dir;
      if (j < 0 || j >= c.segments.length) return;
      [c.segments[index], c.segments[j]] = [c.segments[j], c.segments[index]];
    }, "Reordered story cut scenes");
  }

  /* ------------------------------------------------------------ helpers */

  function renderSegment(s: StoryCutSegment, i: number, c: StoryCut, library = false) {
    const len = segmentLength(s);
    const budget = wordBudget(len, c.voice.speed);
    const words = countWords(s.narration);
    const fit = words === 0 ? "" : words <= budget ? " ok" : words <= Math.ceil(budget * 1.3) ? " warn" : " over";
    const source = c.sources.length > 1 ? assetById(project, s.assetId)?.name : null;
    return (
      <div key={s.id} className={`scene-cut${s.skip ? " skipped" : ""}`}>
        <div className="scene-cut-media">
          {previewId === s.id
            ? <video className="scene-cut-video" src={`${fileUrl(project.id, s.assetId)}#t=${s.start.toFixed(2)},${s.end.toFixed(2)}`} controls autoPlay preload="metadata" />
            : (
              <button type="button" className="scene-cut-frames" onClick={() => setPreviewId(s.id)} title="Play this scene">
                {s.frames.map(f => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={f} src={frameUrl(project.id, f)} alt="" loading="lazy" />
                ))}
                {!s.frames.length && <span className="muted">▷ Play</span>}
              </button>
            )}
          <small className="muted">#{i + 1} · {formatTime(s.start)}–{formatTime(s.end)} · {len.toFixed(1)} s{source ? ` · ${source}` : ""}</small>
          <div className="row-actions">
            {!library && <>
              <button className="tiny-button" disabled={i === 0} onClick={() => moveSegment(i, -1)} aria-label="Move up">↑</button>
              <button className="tiny-button" disabled={i === c.segments.length - 1} onClick={() => moveSegment(i, 1)} aria-label="Move down">↓</button>
              <label className="check inline"><input type="checkbox" checked={!s.skip} onChange={e => editSegment(s.id, x => { x.skip = !e.target.checked; })} /><span>Use</span></label>
            </>}
            {previewId === s.id && <button className="tiny-button" onClick={() => setPreviewId(null)} title="Stop the video and show the picture again">✕ Close video</button>}
          </div>
        </div>
        <div className="scene-cut-text">
          <label>ON SCREEN
            <textarea className="field textarea-small" value={s.description} placeholder="Who is on screen, what they do, the mood…"
              onChange={e => editSegment(s.id, x => { x.description = e.target.value; }, "Edited story cut scene descriptions")} />
          </label>
          {!library && (
            <label>
              <span className="label-row">NARRATION <span className={`budget${fit}`} title="Words that fit this scene at the chosen voice speed">{words}/{budget} words</span></span>
              <textarea className="field textarea-small" value={s.narration} placeholder={s.skip ? "Skipped" : "Leave empty for a pause"}
                onChange={e => editSegment(s.id, x => { x.narration = e.target.value; }, "Edited story cut narration")} />
            </label>
          )}
        </div>
      </div>
    );
  }

  function renderThumb(seg: StoryCutSegment | undefined) {
    if (!seg?.frames[0]) return <span className="muted">No scene</span>;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={frameUrl(project.id, seg.frames[0])} alt="" loading="lazy" />;
  }

  function renderLine(l: StoryCutLine, i: number, c: StoryCut) {
    const seg = c.segments.find(s => s.id === l.sceneId);
    const segIndex = seg ? c.segments.indexOf(seg) : -1;
    const words = countWords(l.text);
    const speak = speakSeconds(l.text, c.voice.speed);
    const len = seg ? segmentLength(seg) : 0;
    const piece = linePiece(l.offset, len, l.text, c.voice.speed);
    const fit = !seg || !words ? "" : !piece.overruns ? " ok" : speak <= len * 1.5 ? " warn" : " over";
    const nudge = (d: number) => editLine(l.id, x => { x.offset = linePiece(piece.from + d, len, x.text, c.voice.speed).from; }, "Moved a clip's start");
    const alternatives = l.options.filter(o => o !== l.sceneId).map(o => c.segments.find(s => s.id === o)).filter((s): s is StoryCutSegment => !!s);
    return (
      <div key={l.id} className="scene-cut">
        <div className="scene-cut-media">
          {seg && previewId === l.id
            ? <video key={`${seg.id}-${piece.from}-${piece.to}`} className="scene-cut-video" src={`${fileUrl(project.id, seg.assetId)}#t=${(seg.start + piece.from).toFixed(2)},${(seg.start + piece.to).toFixed(2)}`} controls autoPlay preload="metadata" />
            : <button type="button" className="scene-cut-frames" onClick={() => (seg ? setPreviewId(l.id) : setPickLineId(l.id))} title={seg ? "Play the part used for this line" : "Choose a scene"}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {seg ? <img src={stillUrl(project.id, seg.assetId, seg.start + piece.from)} alt="" loading="lazy" onError={e => { const k = seg.frames[0] && frameUrl(project.id, seg.frames[0]); if (k && !e.currentTarget.src.endsWith(k)) e.currentTarget.src = k; }} /> : renderThumb(seg)}
              </button>}
          <small className="muted">{seg ? `Scene ${segIndex + 1} · uses ${piece.from.toFixed(1)}–${piece.to.toFixed(1)} s of ${len.toFixed(1)} s` : "No scene chosen"}
            {l.fit && <span className={`fit-badge ${l.fit}`} title="The AI's verdict after looking at this clip's frames">{FIT_LABEL[l.fit]}</span>}</small>
          {seg?.description && <small className="muted scene-desc" title={seg.description}>{seg.description}</small>}
          <div className="row-actions">
            <button className="tiny-button" onClick={() => setPickLineId(l.id)}>Choose scene…</button>
            {seg && <>
              <button className="tiny-button" disabled={piece.from <= 0} onClick={() => nudge(-NUDGE)} title={`Start ${NUDGE} s earlier in the scene`}>◀ Earlier</button>
              <button className="tiny-button" disabled={piece.from >= linePiece(len, len, l.text, c.voice.speed).from} onClick={() => nudge(NUDGE)} title={`Start ${NUDGE} s later in the scene`}>Later ▶</button>
            </>}
            {previewId === l.id && <button className="tiny-button" onClick={() => setPreviewId(null)} title="Stop the video and show the picture again">✕ Close video</button>}
          </div>
          {alternatives.length > 0 && (
            <div className="alt-row" aria-label="Other suggestions">
              {alternatives.map(a => (
                <button key={a.id} type="button" className="alt-thumb" title={`Use scene ${c.segments.indexOf(a) + 1}: ${a.description}`}
                  onClick={() => editLine(l.id, x => { x.sceneId = a.id; x.offset = 0; x.fit = ""; }, "Changed a line's scene")}>{renderThumb(a)}</button>
              ))}
            </div>
          )}
        </div>
        <div className="scene-cut-text">
          <label>
            <span className="label-row">LINE {i + 1}<span className={`budget${fit}`} title="Speaking time vs. scene length. The video follows the voice; a line longer than its scene runs on past the scene's cut.">{speak.toFixed(1)} s{seg ? ` / ${len.toFixed(1)} s scene` : ""}</span></span>
            <textarea className="field textarea-small" value={l.text} onChange={e => editLine(l.id, x => { x.text = e.target.value; })} />
          </label>
          <div className="row-actions">
            <button className="tiny-button" disabled={i === 0} onClick={() => moveLine(i, -1)} aria-label="Move up">↑</button>
            <button className="tiny-button" disabled={i === c.lines.length - 1} onClick={() => moveLine(i, 1)} aria-label="Move down">↓</button>
            <button className="tiny-button" onClick={() => editCut(x => { x.lines.splice(i + 1, 0, { id: newId(), text: "", sceneId: null, options: [], offset: 0, fit: "", query: "", stock: [] }); }, "Added a script line")}>+ Line below</button>
            <button className="tiny-button danger-text" onClick={() => editCut(x => { x.lines = x.lines.filter(y => y.id !== l.id); }, "Removed a script line")}>Remove</button>
          </div>
        </div>
      </div>
    );
  }

  /** Which of a line's found clips is on the timeline (matched by its stock page link in the asset notes). */
  function chosenStockId(l: StoryCutLine, c: StoryCut): string | null {
    const seg = c.segments.find(s => s.id === l.sceneId);
    const asset = seg ? assetById(project, seg.assetId) : undefined;
    return asset ? l.stock.find(o => o.pageUrl && asset.notes.includes(o.pageUrl))?.id ?? null : null;
  }

  function renderStockLine(l: StoryCutLine, i: number, c: StoryCut) {
    const seg = c.segments.find(s => s.id === l.sceneId);
    const words = countWords(l.text);
    const speak = words / (2.4 * c.voice.speed) + 0.5;
    const len = seg ? segmentLength(seg) : 0;
    const isPhoto = seg ? assetById(project, seg.assetId)?.kind === "image" : false;
    const fit = !seg || !words || isPhoto ? "" : speak <= len ? " ok" : speak <= len * 1.5 ? " warn" : " over";
    const chosen = chosenStockId(l, c);
    const lineBusy = busy === `line:${l.id}`;
    return (
      <div key={l.id} className="scene-cut">
        <div className="scene-cut-media">
          {seg && previewId === l.id && !isPhoto
            ? <video className="scene-cut-video" src={fileUrl(project.id, seg.assetId)} controls autoPlay preload="metadata" />
            : <button type="button" className="scene-cut-frames" onClick={() => seg && !isPhoto && setPreviewId(l.id)} title={seg ? (isPhoto ? "Photo (gets a slow zoom)" : "Play this clip") : "No clip yet"}>{renderThumb(seg)}</button>}
          <small className="muted">{seg ? `${isPhoto ? "Photo" : `${len.toFixed(1)} s clip`}${l.query ? ` · “${l.query}”` : ""}` : "No clip yet"}</small>
          {l.stock.length > 0 && (
            <div className="alt-row" aria-label="Other clips found">
              {l.stock.filter(o => o.id !== chosen).slice(0, 3).map(o => (
                <button key={o.id} type="button" className="alt-thumb" disabled={!!busy} title={`Use this ${o.kind}${o.duration ? ` (${o.duration} s)` : ""} by ${o.author}`}
                  onClick={() => void chooseStock(l.id, o.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={frameUrl(project.id, o.thumb)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <div className="stock-search">
            <input className="field" aria-label="Search stock clips" value={lineQuery[l.id] ?? l.query} placeholder="Search other clips…"
              onChange={e => setLineQuery(q => ({ ...q, [l.id]: e.target.value }))}
              onKeyDown={e => { if (e.key === "Enter") void searchLine(l.id, "video"); }} />
            <button className="tiny-button" disabled={!!busy} onClick={() => void searchLine(l.id, "video")}>{lineBusy ? "…" : "Videos"}</button>
            <button className="tiny-button" disabled={!!busy} onClick={() => void searchLine(l.id, "photo")}>Photos</button>
          </div>
        </div>
        <div className="scene-cut-text">
          <label>
            <span className="label-row">LINE {i + 1}<span className={`budget${fit}`} title="Speaking time vs. clip length. A long line holds the clip's last frame.">{speak.toFixed(1)} s{seg && !isPhoto ? ` / ${len.toFixed(1)} s clip` : ""}</span></span>
            <textarea className="field textarea-small" value={l.text} onChange={e => editLine(l.id, x => { x.text = e.target.value; })} />
          </label>
          <div className="row-actions">
            <button className="tiny-button" disabled={i === 0} onClick={() => moveLine(i, -1)} aria-label="Move up">↑</button>
            <button className="tiny-button" disabled={i === c.lines.length - 1} onClick={() => moveLine(i, 1)} aria-label="Move down">↓</button>
            <button className="tiny-button" onClick={() => editCut(x => { x.lines.splice(i + 1, 0, { id: newId(), text: "", sceneId: null, options: [], offset: 0, fit: "", query: "", stock: [] }); }, "Added a script line")}>+ Line below</button>
            <button className="tiny-button danger-text" onClick={() => editCut(x => { x.lines = x.lines.filter(y => y.id !== l.id); }, "Removed a script line")}>Remove</button>
          </div>
        </div>
      </div>
    );
  }

  /** "Video by X on Pixabay: url" for every stock clip on the timeline, for the YouTube description. */
  function stockCredits(c: StoryCut): string {
    const used = new Set(c.lines.map(l => l.sceneId).filter(Boolean));
    const out: string[] = [];
    for (const seg of c.segments.filter(s => used.has(s.id))) {
      const a = assetById(project, seg.assetId);
      const m = a && /^(Video|Photo) by (.+?) on (Pixabay|Pexels): (\S+)/.exec(a.notes);
      if (m) out.push(`${m[1]} by ${m[2]} on ${m[3]}: ${m[4]}`);
    }
    return [...new Set(out)].join("\n");
  }

  function renderScenePicker(c: StoryCut) {
    const line = c.lines.find(l => l.id === pickLineId);
    if (!line) return null;
    const usedElsewhere = new Set(c.lines.filter(l => l.id !== line.id && l.sceneId).map(l => l.sceneId));
    return (
      <Modal title="Choose a scene for this line" onClose={() => setPickLineId(null)} wide>
        <p className="small">“{line.text || "(empty line)"}”</p>
        <div className="scene-picker">
          {c.segments.map((s, i) => (
            <button key={s.id} type="button" className={`scene-pick${s.id === line.sceneId ? " selected" : ""}`}
              onClick={() => { editLine(line.id, x => { if (x.sceneId !== s.id) { x.sceneId = s.id; x.offset = 0; x.fit = ""; } }, "Changed a line's scene"); setPickLineId(null); }}>
              {renderThumb(s)}
              <small><b>Scene {i + 1}</b> · {segmentLength(s).toFixed(1)} s{usedElsewhere.has(s.id) ? " · used" : ""}</small>
              <small className="muted">{s.description || "No description"}</small>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  /** How long a job has run (live) or took, as m:ss / h:mm:ss. */
  function elapsed(j: StoryJobView): string {
    const ms = Math.max(0, (j.finishedAt ? Date.parse(j.finishedAt) : now) - Date.parse(j.createdAt));
    const s = Math.round(ms / 1000);
    return s >= 3600 ? `${Math.floor(s / 3600)}:${formatTime(s % 3600).padStart(5, "0")}` : formatTime(s);
  }

  const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  /** Live status line for a running job: elapsed time + current step. */
  function renderLive(j: StoryJobView | undefined) {
    if (j?.status === "failed") return <div className="job-failed"><p className="small error-text">Last run failed after {elapsed(j)}: {j.error}</p>{renderResume(j)}</div>;
    if (j?.status !== "running") return null;
    return <p className="small find-progress"><span className="elapsed">⏱ {elapsed(j)}</span> {j.progress ?? "Starting…"}</p>;
  }

  function renderJob(j: StoryJobView) {
    return (
      <div key={j.id} className={`gen-card ${j.status}`}>
        <div className="gen-head">
          <span className={`status-pill ${j.status}`}>{j.status === "running" ? "Running" : j.status === "succeeded" ? "Done" : "Failed"}</span>
          <small className="muted">{KIND_LABEL[j.kind]}</small>
          <small className="muted job-time" title={`Started ${new Date(j.createdAt).toLocaleString()}`}>
            {j.status === "running" ? `⏱ ${elapsed(j)} so far` : `took ${elapsed(j)}`} · started {clock(j.createdAt)}
          </small>
        </div>
        {j.status === "running" && <p className="small">{j.progress ?? "Working…"}</p>}
        {j.error && <p className="error-text small">{j.error}</p>}
        {j.notes && j.status !== "running" && <p className="muted small">{j.notes}</p>}
        {renderResume(j)}
      </div>
    );
  }

  /* ------------------------------------------------------------- view */

  const header = (
    <div className="section-head">
      <div>
        <span className="eyebrow">NARRATED STORIES</span>
        <h3>Story Cuts</h3>
        <p>Tell a new story over existing footage: the people on screen become your characters, and a voiceover tells their story.</p>
      </div>
      {tools && <span className={`connection-pill${tools.ok ? " ok" : " warn"}`}>{tools.ok ? "ffmpeg ready" : "ffmpeg missing"}</span>}
    </div>
  );

  if (!cut) {
    return (
      <div className="content story-cuts">
        {header}
        <EmptyState>
          <p>No story cuts yet. Start one, add a video, and Wonderboy finds the scenes, describes them, writes a story that fits, and renders the narrated video.</p>
          <button className="button primary" onClick={createCut}>New story cut</button>
        </EmptyState>
      </div>
    );
  }

  const scriptMode = cut.mode === "script";
  const stockMode = cut.mode === "stock";
  const lineMode = scriptMode || stockMode;
  const used = cut.segments.filter(s => !s.skip);
  const linesWithScene = cut.lines.filter(l => l.sceneId && cut.segments.some(s => s.id === l.sceneId));
  const narrationWords = lineMode
    ? linesWithScene.reduce((n, l) => n + countWords(l.text), 0)
    : used.reduce((n, s) => n + countWords(s.narration), 0);
  const estVideo = lineMode
    ? linesWithScene.reduce((n, l) => {
      const w = countWords(l.text);
      const s = cut.segments.find(x => x.id === l.sceneId)!;
      return n + (w ? Math.max(2, w / (2.4 * cut.voice.speed) + 0.5) : segmentLength(s));
    }, 0)
    : used.reduce((n, s) => {
      const w = countWords(s.narration);
      return n + Math.max(segmentLength(s), w ? w / (2.4 * cut.voice.speed) + 0.5 : 0);
    }, 0);
  const renderable = lineMode ? linesWithScene.length : used.length;
  const estVoice = narrationWords / (2.4 * cut.voice.speed);
  const voiceProvider = audioProviders.find(p => p.id === cut.voice.providerId) ?? audioProviders[0];
  const voiceCaps = voiceProvider?.caps;
  const described = cut.segments.filter(s => s.description.trim()).length;
  const outputs = cut.outputAssetIds.map(id => assetById(project, id)).filter(a => !!a).reverse();
  const addable = videoAssets.filter(a => !cut.sources.some(s => s.assetId === a.id));
  const style = styleById(cut.style);
  const autoJob = cutJobs.find(j => j.kind === "auto");
  const stockJob = cutJobs.find(j => j.kind === "stock");

  return (
    <div className="content story-cuts">
      {header}
      {tools && !tools.ok && <div className="setup-note"><strong>One-time setup:</strong><p>{tools.error}</p></div>}

      <div className="panel story-cut-bar">
        <Dropdown ariaLabel="Story cut" value={cut.id} onChange={v => setSelectedId(v)}
          options={project.storyCuts.map(c => ({ value: c.id, label: c.title }))} />
        <input className="field" aria-label="Title" value={cut.title} onChange={e => editCut(c => { c.title = e.target.value; }, "Renamed a story cut")} />
        <button className="button secondary" onClick={createCut}>New</button>
        <button className="tiny-button danger-text" onClick={deleteCut}>Delete</button>
      </div>

      <div className="panel">
        <span className="field-label">HOW DO YOU WANT TO MAKE THIS VIDEO?</span>
        <div className="chip-select" role="radiogroup" aria-label="How to make the video">
          <button type="button" className={`chip${stockMode ? " on" : ""}`} aria-pressed={stockMode} onClick={() => editCut(c => { c.mode = "stock"; }, "Switched a story cut to stock mode")}>My script + free stock clips</button>
          <button type="button" className={`chip${scriptMode ? " on" : ""}`} aria-pressed={scriptMode} onClick={() => editCut(c => { c.mode = "script"; }, "Switched a story cut to script mode")}>My script + clips from my film</button>
          <button type="button" className={`chip${!lineMode ? " on" : ""}`} aria-pressed={!lineMode} onClick={() => editCut(c => { c.mode = "story"; }, "Switched a story cut to AI story mode")}>Write a story for my footage</button>
        </div>
        <p className="muted small">
          {stockMode ? "Best when the narrator tells the story and characters don't need to look the same from shot to shot. Clips come from Pixabay: free for monetized videos."
            : scriptMode ? "Clips come from videos you upload. With one film, characters stay consistent; with several, the AI mixes them evenly."
            : "The AI writes a new story where the people in your footage become the characters."}
        </p>
      </div>

      {lineMode ? <>
        {/* Script / stock mode: script first */}
        <div className="panel">
          <h3 className="step-title"><span className="step-num">1</span> Your script</h3>
          <textarea className="field script-box" aria-label="Your script" value={cut.script} placeholder="Paste the narration your voiceover will read…"
            onChange={e => editCut(c => { c.script = e.target.value; }, "Edited a story cut script")} />
          <small className="muted">{countWords(cut.script)} words · about {formatTime(countWords(cut.script) / (2.4 * cut.voice.speed))} of narration</small>
          {stockMode && <p className="muted small">Put the clips or pictures you want in brackets, e.g. <code>(Clips: man spills coffee on shirt, bus driving away)</code> or <code>(Images: empty wallet)</code>. Movie and TV references are turned into similar generic shots, because stock sites don&apos;t have them.</p>}
          {scriptMode && <details className="cast-details" open={cut.cast.length > 0}>
            <summary>Cast (optional: the AI suggests it when you find clips)</summary>
            <span className="field-label">CAST <small className="muted">character = how they look in the footage</small></span>
            <div className="stack">
              {cut.cast.map((m, i) => (
                <div key={i} className="cast-row">
                  <input className="field" aria-label="Character name" value={m.name} placeholder="Name in your script"
                    onChange={e => editCut(c => { c.cast[i].name = e.target.value; }, "Edited the cast")} />
                  <input className="field" aria-label="Look in the footage" value={m.look} placeholder="e.g. old man in a grey coat"
                    onChange={e => editCut(c => { c.cast[i].look = e.target.value; }, "Edited the cast")} />
                  <button className="tiny-button" onClick={() => editCut(c => { c.cast.splice(i, 1); }, "Edited the cast")}>Remove</button>
                </div>
              ))}
            </div>
            <div className="button-row">
              {described > 0 && <button className="button secondary" disabled={!!busy || !cut.script.trim()} onClick={() => void suggestCast()}>{busy === "cast" ? "Casting…" : "Suggest cast again"}</button>}
              <button className="tiny-button" onClick={() => editCut(c => { c.cast.push({ name: "", look: "" }); }, "Edited the cast")}>+ Add character</button>
            </div>
          </details>}
        </div>

        {stockMode && <>
          <div className="panel">
            <h3 className="step-title"><span className="step-num">2</span> Find free stock clips</h3>
            {tools && !tools.stock && <p className="warn-text">Needs a free Pixabay API key: sign up at pixabay.com, copy your key from pixabay.com/api/docs, add <code>PIXABAY_API_KEY=…</code> to .env.local, then close the Wonderboy window and start it again.</p>}
            {!ai.providers?.activeLlm && ai.providers && <p className="muted small">No AI key set: lines and searches come straight from your bracket notes. With GEMINI_API_KEY the AI splits the script and writes better searches.</p>}
            <div className="find-clips">
              <button className="button primary big" disabled={!cut.script.trim() || !!busy || running.has("stock") || (!!tools && !tools.stock)} onClick={findStock}>
                {running.has("stock") ? "Finding clips…" : cut.lines.length ? "Find stock clips again" : "Find stock clips for my script"}
              </button>
              {renderLive(stockJob)}
              {!running.has("stock") && <small className="muted">Searches {tools?.stock ?? "Pixabay"} for each line and downloads the best clip (about 5–30 MB each). A 2–3 minute script takes a few minutes.</small>}
            </div>
            <p className="muted small">
              {tools?.stock ?? "Pixabay"} licence: free for commercial use. Don&apos;t show recognisable people in an offensive or misleading way, or imply they endorse something.{" "}
              {tools?.stock === "Pexels"
                ? <a href="https://www.pexels.com" target="_blank" rel="noreferrer">Videos provided by Pexels</a>
                : <a href="https://pixabay.com" target="_blank" rel="noreferrer">Videos and photos from Pixabay</a>}.
            </p>
          </div>

          {cut.lines.length > 0 && (
            <div className="panel">
              <h3 className="step-title"><span className="step-num">3</span> Clips for your script <small className="muted">{cut.lines.length} lines · {linesWithScene.length} with a clip · about {formatTime(estVideo)} of video</small></h3>
              <p className="muted small">Click a picture to play the clip. Click a small thumbnail to use that clip instead, or search with your own words.</p>
              <div className="scene-cut-list">{cut.lines.map((l, i) => renderStockLine(l, i, cut))}</div>
              {stockCredits(cut) && (
                <details className="advanced">
                  <summary>Credits for your video description</summary>
                  <pre className="code-block">{stockCredits(cut)}</pre>
                  <button className="tiny-button" onClick={() => { void navigator.clipboard?.writeText(stockCredits(cut)); notify("Credits copied."); }}>Copy credits</button>
                </details>
              )}
            </div>
          )}
        </>}

        {scriptMode && <>
        <div className="panel">
          <h3 className="step-title"><span className="step-num">2</span> Your film</h3>
        <p className="muted small">
          Use footage you&apos;re allowed to monetize: free stock clips (Pexels, Pixabay) or public-domain films (check each film&apos;s status).
          Clips from copyrighted movies are usually claimed by YouTube&apos;s Content ID.
        </p>
        {cut.sources.length === 0 && <p className="small">Add one long film or several stock clips.</p>}
        <div className="stack">
          {cut.sources.map((src, i) => (
            <div key={src.assetId} className="source-row">
              <span className="source-name" title={assetById(project, src.assetId)?.name}>{i + 1}. {assetById(project, src.assetId)?.name ?? "Missing file"}</span>
              <label>FROM<input className="field" placeholder="start" defaultValue={src.start !== null ? formatTime(src.start) : ""}
                onBlur={e => editCut(c => { const x = c.sources.find(y => y.assetId === src.assetId); if (x) x.start = parseTime(e.target.value); }, "Edited story cut footage")} /></label>
              <label>TO<input className="field" placeholder="end" defaultValue={src.end !== null ? formatTime(src.end) : ""}
                onBlur={e => editCut(c => { const x = c.sources.find(y => y.assetId === src.assetId); if (x) x.end = parseTime(e.target.value); }, "Edited story cut footage")} /></label>
              <button className="tiny-button" onClick={() => editCut(c => { c.sources = c.sources.filter(x => x.assetId !== src.assetId); }, "Removed footage from a story cut")}>Remove</button>
            </div>
          ))}
        </div>
        <div className="button-row">
          <Dropdown ariaLabel="Add a video" value={addId} onChange={v => setAddId(v)}
            options={[{ value: "", label: addable.length ? "Choose a video from the library…" : "No other videos in the library" }, ...addable.map(a => ({ value: a.id, label: a.name }))]} />
          <button className="button secondary" disabled={!addId} onClick={() => { editCut(c => { c.sources.push({ assetId: addId, start: null, end: null }); }, "Added footage to a story cut"); setAddId(""); }}>Add</button>
          <UploadButton label="Upload videos" accept="video/*" onFiles={files => ws.uploadFiles(files, (d, assets) => {
            const c = d.storyCuts.find(x => x.id === cut.id);
            if (c) for (const a of assets) if (a.kind === "video") c.sources.push({ assetId: a.id, start: null, end: null });
          }, "Uploaded footage for a story cut")} />
        </div>
          {!ai.providers?.activeLlm && ai.providers && <p className="warn-text">Finding clips needs the AI: add GEMINI_API_KEY to .env.local (free at aistudio.google.com), then close the Wonderboy window and start it again.</p>}
          {cut.sources.length > 1 && <label className="check">
            <input type="checkbox" checked={cut.mix} onChange={e => editCut(c => { c.mix = e.target.checked; }, e.target.checked ? "Mix clips from all videos" : "Use the best match from any video")} />
            <span>Mix clips from all my videos <small className="muted">(spread evenly; turn off to keep the best match and the same faces)</small></span>
          </label>}
          <div className="find-clips">
            <button className="button primary big" disabled={!cut.sources.length || !cut.script.trim() || !!busy || running.has("auto") || running.has("detect") || running.has("describe") || tools?.ok === false} onClick={findClips}>
              {running.has("auto") ? "Finding clips…" : cut.lines.length ? "Find clips again" : "Find clips for my script"}
            </button>
            {renderLive(autoJob)}
            {!running.has("auto") && <small className="muted">The AI scans your film, watches every scene, picks a clip for each line, then looks closely at each pick and starts it at the right moment. A 15-minute stretch of film takes about 5–15 minutes on this laptop.</small>}
          </div>
          <details className="advanced">
            <summary>Advanced</summary>
            <div className="button-row">
              <Dropdown ariaLabel="Scene sensitivity" value={String(sensitivity)} onChange={v => setSensitivity(Number(v))}
                options={SENSITIVITY.map(x => ({ value: String(x.value), label: x.label }))} />
              {cut.segments.length > 0 && <label className="check inline"><input type="checkbox" checked={rescan} onChange={e => setRescan(e.target.checked)} /><span>Scan the film again (after changing FROM/TO)</span></label>}
            </div>
            {cut.segments.length > 0 && <>
              <p className="muted small">{cut.segments.length} scenes found · {described} watched. If the AI stopped early, these buttons finish single steps:</p>
          <div className="button-row">
            <button className="button primary" disabled={!!busy || running.has("describe")} onClick={() => void start("describe", { overwrite: overwriteDescriptions })}>
              {running.has("describe") ? "Describing…" : "Describe scenes with AI"}
            </button>
            <label className="check inline"><input type="checkbox" checked={overwriteDescriptions} onChange={e => setOverwriteDescriptions(e.target.checked)} /><span>Redo existing descriptions</span></label>
          </div>
          {renderLive(cutJobs.find(j => j.kind === "describe"))}
              <div className="button-row">
                <button className="button secondary" disabled={!!busy || !cut.script.trim() || !described} onClick={() => void matchScript()}>{busy === "match" ? "Matching…" : "Only re-match clips (keep scenes and cast)"}</button>
              </div>
            </>}
          </details>
        </div>

        {(cut.lines.length > 0 || cut.segments.length > 0) && (
          <div className="panel">
            <h3 className="step-title"><span className="step-num">3</span> Clips for your script <small className="muted">{cut.lines.length} lines · {linesWithScene.length} with a clip · about {formatTime(estVideo)} of video</small></h3>
            {cut.lines.length > 0 && <p className="muted small">Click a picture to play exactly the part that goes into the video. ◀ Earlier / Later ▶ moves it within the scene. Click a small thumbnail to swap in another suggestion, or “Choose scene…” to browse every scene.</p>}
            {linesWithScene.length > 0 && <div className="find-clips">
              <div className="button-row">
                <button className="button secondary" disabled={!!busy || running.has("check") || running.has("auto")} onClick={() => void start("check")}>
                  {running.has("check") ? "Checking clips…" : "Check clips with AI"}
                </button>
              </div>
              {renderLive(cutJobs.find(j => j.kind === "check"))}
              {!running.has("check") && <small className="muted">The AI looks at frames from each line&apos;s clip and its alternatives, keeps the one that shows the line best, starts it at the right moment and marks weak matches. About 1–3 minutes for 30 lines.</small>}
            </div>}
            {cut.lines.length > 0 && <div className="scene-cut-list">{cut.lines.map((l, i) => renderLine(l, i, cut))}</div>}
            <details className="scene-library">
              <summary>Scene library ({cut.segments.length} scenes): check and fix descriptions</summary>
              <div className="scene-cut-list">{cut.segments.map((s, i) => renderSegment(s, i, cut, true))}</div>
            </details>
            {renderScenePicker(cut)}
          </div>
        )}
        </>}
      </> : <>
        {/* Story mode: footage → scenes → AI story */}
        <div className="panel">
          <h3 className="step-title"><span className="step-num">1</span> Footage</h3>
        <p className="muted small">
          Use footage you&apos;re allowed to monetize: free stock clips (Pexels, Pixabay) or public-domain films (check each film&apos;s status).
          Clips from copyrighted movies are usually claimed by YouTube&apos;s Content ID.
        </p>
        {cut.sources.length === 0 && <p className="small">Add one long film or several stock clips.</p>}
        <div className="stack">
          {cut.sources.map((src, i) => (
            <div key={src.assetId} className="source-row">
              <span className="source-name" title={assetById(project, src.assetId)?.name}>{i + 1}. {assetById(project, src.assetId)?.name ?? "Missing file"}</span>
              <label>FROM<input className="field" placeholder="start" defaultValue={src.start !== null ? formatTime(src.start) : ""}
                onBlur={e => editCut(c => { const x = c.sources.find(y => y.assetId === src.assetId); if (x) x.start = parseTime(e.target.value); }, "Edited story cut footage")} /></label>
              <label>TO<input className="field" placeholder="end" defaultValue={src.end !== null ? formatTime(src.end) : ""}
                onBlur={e => editCut(c => { const x = c.sources.find(y => y.assetId === src.assetId); if (x) x.end = parseTime(e.target.value); }, "Edited story cut footage")} /></label>
              <button className="tiny-button" onClick={() => editCut(c => { c.sources = c.sources.filter(x => x.assetId !== src.assetId); }, "Removed footage from a story cut")}>Remove</button>
            </div>
          ))}
        </div>
        <div className="button-row">
          <Dropdown ariaLabel="Add a video" value={addId} onChange={v => setAddId(v)}
            options={[{ value: "", label: addable.length ? "Choose a video from the library…" : "No other videos in the library" }, ...addable.map(a => ({ value: a.id, label: a.name }))]} />
          <button className="button secondary" disabled={!addId} onClick={() => { editCut(c => { c.sources.push({ assetId: addId, start: null, end: null }); }, "Added footage to a story cut"); setAddId(""); }}>Add</button>
          <UploadButton label="Upload videos" accept="video/*" onFiles={files => ws.uploadFiles(files, (d, assets) => {
            const c = d.storyCuts.find(x => x.id === cut.id);
            if (c) for (const a of assets) if (a.kind === "video") c.sources.push({ assetId: a.id, start: null, end: null });
          }, "Uploaded footage for a story cut")} />
        </div>
        <div className="button-row">
          <Dropdown ariaLabel="Scene sensitivity" value={String(sensitivity)} onChange={v => setSensitivity(Number(v))}
            options={SENSITIVITY.map(s => ({ value: String(s.value), label: s.label }))} />
          <button className="button primary" disabled={!cut.sources.length || !!busy || running.has("detect") || tools?.ok === false} onClick={detect}>
            {running.has("detect") ? "Finding scenes…" : cut.segments.length ? "Detect scenes again" : "Detect scenes"}
          </button>
        </div>
        {renderLive(cutJobs.find(j => j.kind === "detect"))}
        <p className="muted small">Long films take a few minutes on this laptop. Set FROM/TO (e.g. 12:30) to use only part of a film.</p>
        </div>

        {cut.segments.length > 0 && (
          <div className="panel">
            <h3 className="step-title"><span className="step-num">2</span> Scenes <small className="muted">{cut.segments.length} scenes · {described} described · {formatTime(cut.segments.reduce((n, x) => n + segmentLength(x), 0))} of footage</small></h3>
            <p className="muted small">The AI sees 1–2 still frames per scene, so it can misread an action or a feeling. Fix descriptions where needed: the story is written from them.</p>
          <div className="button-row">
            <button className="button primary" disabled={!!busy || running.has("describe")} onClick={() => void start("describe", { overwrite: overwriteDescriptions })}>
              {running.has("describe") ? "Describing…" : "Describe scenes with AI"}
            </button>
            <label className="check inline"><input type="checkbox" checked={overwriteDescriptions} onChange={e => setOverwriteDescriptions(e.target.checked)} /><span>Redo existing descriptions</span></label>
          </div>
          {renderLive(cutJobs.find(j => j.kind === "describe"))}
            <h3 className="step-title"><span className="step-num">3</span> Story</h3>
          <div className="form-grid">
            <label>STYLE
              <Dropdown value={cut.style} onChange={v => editCut(c => { c.style = v; }, "Changed story cut style")}
                options={STORY_STYLES.map(s => ({ value: s.id, label: `${s.label} — ${s.footage}` }))} />
            </label>
            <label>YOUR DIRECTION (OPTIONAL)
              <textarea className="field textarea-small" value={cut.instructions} placeholder="e.g. The old man is the narrator's father. Set in Mumbai. End with forgiveness."
                onChange={e => editCut(c => { c.instructions = e.target.value; }, "Edited story cut direction")} />
            </label>
          </div>
          {style.prompt && <p className="muted small">{style.prompt}</p>}
          <div className="button-row">
            <button className="button primary" disabled={!!busy || !described} onClick={() => void writeStory()}>{busy === "story" ? "Writing…" : "Write story with AI"}</button>
            <small className="muted">{narrationWords} words of narration · about {formatTime(estVideo)} of video</small>
          </div>

          <div className="scene-cut-list">{cut.segments.map((s, i) => renderSegment(s, i, cut))}</div>
          </div>
        )}
      </>}

      {/* 4. Voice and render */}
      {(lineMode ? cut.lines.length > 0 : cut.segments.length > 0) && (
        <div className="panel">
          <h3 className="step-title"><span className="step-num">4</span> Voice &amp; video</h3>
          <div className="form-grid three">
            <label>VOICE ENGINE
              <Dropdown value={voiceProvider?.id ?? ""} onChange={v => {
                const p = audioProviders.find(x => x.id === v);
                editCut(c => { c.voice = { providerId: v, voice: p?.caps.voices[0]?.id ?? "", speed: p?.caps.speed?.default ?? 1 }; }, "Changed story cut voice");
              }} options={audioProviders.map(p => ({ value: p.id, label: `${p.label}${p.configured ? "" : " (not configured)"}` }))} />
            </label>
            <label>VOICE
              <Dropdown value={cut.voice.voice} onChange={val => editCut(c => { c.voice.voice = val; }, "Changed story cut voice")}
                options={(voiceCaps?.voices ?? []).map(v => ({ value: v.id, label: v.label }))} />
            </label>
            {voiceCaps?.speed && (
              <label>SPEED {cut.voice.speed.toFixed(2)}×
                <input className="range" type="range" min={voiceCaps.speed.min} max={voiceCaps.speed.max} step={0.05} value={cut.voice.speed}
                  onChange={e => editCut(c => { c.voice.speed = Number(e.target.value); }, "Changed story cut voice")} />
              </label>
            )}
            <label>FILM SOUND UNDER THE VOICE {Math.round(cut.filmVolume * 100)}%
              <input className="range" type="range" min={0} max={1} step={0.05} value={cut.filmVolume}
                onChange={e => editCut(c => { c.filmVolume = Number(e.target.value); }, "Changed story cut film volume")} />
            </label>
          </div>
          <p className="muted small">
            Output: 1920×1080, 30 fps MP4. About {formatTime(estVideo)} long. On this laptop the voice takes roughly {Math.max(1, Math.round(estVoice * 3 / 60))} min
            and the video about {Math.max(1, Math.round(estVideo / 60))} min to render; it runs in the background. Re-renders reuse unchanged voice lines.
          </p>
          <div className="button-row">
            <button className="button primary" disabled={!!busy || running.has("render") || !renderable || tools?.ok === false} onClick={() => void start("render")}>
              {running.has("render") ? "Rendering…" : "Render video"}
            </button>
          </div>
          {renderLive(cutJobs.find(j => j.kind === "render"))}

          {outputs.length > 0 && (
            <div className="stack story-outputs">
              {outputs.map(a => (
                <div key={a!.id} className="story-output">
                  <video src={fileUrl(project.id, a!.id)} controls preload="metadata" />
                  <span className="row-actions">
                    <small className="muted">{a!.name}</small>
                    <a className="tiny-button" href={fileUrl(project.id, a!.id)} download={a!.name}>Download MP4</a>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {cutJobs.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>Activity</h3><button className="text-button" onClick={() => void refresh()}>Refresh</button></div>
          <div className="stack">{cutJobs.slice(0, 6).map(renderJob)}</div>
        </div>
      )}
    </div>
  );
}
