"use client";
import { useEffect, useMemo, useState } from "react";
import { buildContinuityBundle, continuityPrompt, referenceImageCount, type ReferenceImage } from "@/lib/continuity";
import { sceneLabel, shotNumber } from "@/lib/projectModel";
import type { ID } from "@/lib/types";
import { ContinuityPicker, type ContinuityValue } from "./ContinuityPicker";
import { useStudio } from "./studio";

function RefThumbs({ images }: { images: ReferenceImage[] }) {
  if (!images.length) return <small className="warn-text">No reference images</small>;
  return (
    <span className="ref-strip">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {images.slice(0, 6).map(i => <img key={`${i.role}-${i.assetId}`} src={i.url} alt={i.name} title={`${i.name} (${i.role})`} loading="lazy" />)}
      {images.length > 6 && <small className="muted">+{images.length - 6}</small>}
    </span>
  );
}

export function GenerationStudio({ mode }: { mode: "image" | "video" }) {
  const { project, notify, go, focusShotId, setFocusShotId } = useStudio();
  const [shotId, setShotId] = useState<ID | "">(focusShotId ?? "");
  const [manual, setManual] = useState<ContinuityValue>({ characters: [], locationId: null, locationAngleId: null });
  const [prompt, setPrompt] = useState("");
  const [prepared, setPrepared] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  useEffect(() => {
    if (focusShotId) { setShotId(focusShotId); setFocusShotId(null); }
  }, [focusShotId, setFocusShotId]);

  const shot = project.shots.find(s => s.id === shotId);
  const bundle = useMemo(
    () => buildContinuityBundle(project, shot ? { shotId: shot.id } : manual),
    [project, shot, manual],
  );
  const refCount = referenceImageCount(bundle);
  const missingRefs = bundle.characters.filter(c => c.referenceImages.length === 0).length + (bundle.location && bundle.location.referenceImages.length === 0 ? 1 : 0);

  async function generate() {
    const text = prepared.trim() || continuityPrompt(bundle, prompt);
    if (!prompt.trim() && !shot) { notify("Write a prompt or select a shot first."); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/generate/${mode}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, userPrompt: prompt, continuity: bundle }),
      });
      const data = await res.json();
      setResult(data.message || data.error || "Request completed.");
    } catch {
      setResult("Generation service is not configured yet. See docs/PROVIDERS.md.");
    } finally {
      setBusy(false);
    }
  }

  const isImage = mode === "image";
  return (
    <div className="content">
      <div className="section-head">
        <div>
          <span className="eyebrow">{isImage ? "CREATE YOUR VISUALS" : "BRING SHOTS TO LIFE"}</span>
          <h3>{isImage ? "Image generation" : "Video generation"}</h3>
          <p>{isImage ? "Prepare frames from a planned shot with its character and location references." : "Prepare motion prompts from a planned shot with its continuity references."}</p>
        </div>
        <span className="connection-pill">Provider adapter · not connected</span>
      </div>

      <div className="generator-layout">
        <div className="panel">
          <label>SHOT
            <select className="field" value={shotId} onChange={e => { setShotId(e.target.value); setPrepared(""); }}>
              <option value="">— No shot: choose references manually —</option>
              {project.scenes.map(sc => {
                const list = project.shots.filter(s => s.sceneId === sc.id);
                return list.length ? <optgroup key={sc.id} label={sceneLabel(project, sc)}>{list.map(s => <option key={s.id} value={s.id}>Shot {shotNumber(project, s)}{s.title ? ` · ${s.title}` : ""}</option>)}</optgroup> : null;
              })}
              {project.shots.some(s => !s.sceneId) && (
                <optgroup label="Unassigned">{project.shots.filter(s => !s.sceneId).map(s => <option key={s.id} value={s.id}>Shot {shotNumber(project, s)}{s.title ? ` · ${s.title}` : ""}</option>)}</optgroup>
              )}
            </select>
          </label>

          {shot
            ? <p className="muted small">Using the shot&apos;s camera details and continuity links. <button className="text-button" onClick={() => go("Shots")}>Edit shot ↗</button></p>
            : <ContinuityPicker value={manual} onChange={patch => { setManual(m => ({ ...m, ...patch })); setPrepared(""); }} />}

          <label>{isImage ? "ADDITIONAL IMAGE PROMPT" : "ADDITIONAL MOTION PROMPT"}
            <textarea className="field prompt-editor" value={prompt} onChange={e => { setPrompt(e.target.value); setPrepared(""); }}
              placeholder={isImage ? "Composition, lens, lighting and action details…" : "Subject movement, camera movement, atmosphere and duration…"} />
          </label>

          <div className="continuity-box">
            <strong>Continuity references attached to the request</strong>
            {bundle.characters.length === 0 && !bundle.location && <p>No characters or location selected.</p>}
            {bundle.characters.map(c => (
              <div key={c.characterId} className="ref-line"><span>◉ {c.name} <small className="muted">· {c.wardrobe.name} wardrobe</small></span><RefThumbs images={c.referenceImages} /></div>
            ))}
            {bundle.location && (
              <div className="ref-line"><span>⌂ {bundle.location.name}{bundle.location.angle ? <small className="muted"> · {bundle.location.angle.name}</small> : null}</span><RefThumbs images={bundle.location.referenceImages} /></div>
            )}
            {bundle.additionalReferences.length > 0 && <div className="ref-line"><span>▧ Shot references</span><RefThumbs images={bundle.additionalReferences} /></div>}
            <small>
              {refCount} reference image{refCount === 1 ? "" : "s"} and the saved descriptions will be sent as structured data.
              {missingRefs > 0 && ` ${missingRefs} selected record(s) have no reference images.`} Visual consistency is not guaranteed: no reference-conditioned generation provider is connected yet.
            </small>
          </div>

          <div className="button-row">
            <button className="button secondary" onClick={() => { setPrepared(continuityPrompt(bundle, prompt)); notify("Continuity prompt prepared."); }}>Prepare continuity prompt</button>
            <button className="button primary" disabled={busy} onClick={generate}>{busy ? "Working…" : `Generate ${mode} ↗`}</button>
          </div>
          {result && <p className="result-note">{result}</p>}

          <label>PREPARED PROMPT
            <textarea className="field prompt-editor" value={prepared} onChange={e => setPrepared(e.target.value)} placeholder="Your combined style, shot and continuity prompt will appear here. You can edit it before generating." />
          </label>
          <div className="button-row">
            <button className="button secondary" disabled={!prepared} onClick={() => navigator.clipboard.writeText(prepared).then(() => notify("Prompt copied."), () => notify("Copy failed."))}>Copy prepared prompt</button>
            <button className="button secondary" onClick={() => navigator.clipboard.writeText(JSON.stringify(bundle, null, 2)).then(() => notify("Continuity JSON copied."), () => notify("Copy failed."))}>Copy continuity JSON</button>
          </div>
        </div>

        <div className="panel side-info">
          <h3>Generation notes</h3>
          <p>Generation is deliberately provider-independent. No paid GPU or model has been connected.</p>
          <ul className="plain-list">
            <li>Requests carry a structured continuity bundle: shot spec, characters (identity + wardrobe), location (+ angle) and reference image URLs.</li>
            <li>Text prompts alone do not keep characters consistent. Reference-image conditioning, image-to-image or trained LoRAs are needed.</li>
            <li>Keep provider keys on the server, never in browser code.</li>
            <li>Video generation may need a hosted GPU or a limited free runtime.</li>
          </ul>
          <button className="text-button" onClick={() => go("Settings")}>Provider settings ↗</button>
        </div>
      </div>
    </div>
  );
}
