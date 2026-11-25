"use client";
import { useEffect, useMemo, useState } from "react";
import { aiApi, prepareImage, type GenerationView } from "@/lib/client/ai";
import { buildContinuityBundle, continuityPrompt, type ReferenceImage } from "@/lib/continuity";
import { assetById, fileUrl, sceneLabel, shotNumber, timeAgo } from "@/lib/projectModel";
import type { ImageProviderInfo, ReferenceInput, VideoProviderInfo } from "@/lib/ai/types";
import { billingLabel } from "@/lib/ai/types";
import type { Asset, ID } from "@/lib/types";
import { ContinuityPicker, type ContinuityValue } from "./ContinuityPicker";
import { AssetPreview, useStudio } from "./studio";

type Mode = "image" | "video";
interface Candidate { assetId: ID; label: string; role: ReferenceInput["role"]; primary: boolean }

const ROLE_MAP: Record<ReferenceImage["role"], ReferenceInput["role"]> = {
  identity: "character", wardrobe: "wardrobe", location: "location", "location-angle": "location-angle", shot: "shot",
};

export function GenerationStudio({ mode }: { mode: Mode }) {
  const { ws, project, ai, notify, go, focusShotId, setFocusShotId, pendingSourceId, setPendingSourceId } = useStudio();
  const isImage = mode === "image";
  const providers = useMemo<(ImageProviderInfo | VideoProviderInfo)[]>(() => (isImage ? ai.providers?.image : ai.providers?.video) ?? [], [isImage, ai.providers]);

  const [shotId, setShotId] = useState<ID | "">(focusShotId ?? "");
  const [manual, setManual] = useState<ContinuityValue>({ characters: [], locationId: null, locationAngleId: null });
  const [providerId, setProviderId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [selectedRefs, setSelectedRefs] = useState<ID[] | null>(null); // null = automatic selection
  const [sourceId, setSourceId] = useState<ID | "">(pendingSourceId ?? "");
  // image settings
  const [aspect, setAspect] = useState("16:9");
  const [size, setSize] = useState("1K");
  const [steps, setSteps] = useState<number | "">("");
  const [seed, setSeed] = useState<number | "">("");
  const [guidance, setGuidance] = useState<number | "">("");
  const [count, setCount] = useState(1);
  // video settings
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState("720p");
  const [audio, setAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Consume cross-tab requests (shot from planner, source image from "Animate").
  useEffect(() => { if (focusShotId) { setShotId(focusShotId); setFocusShotId(null); } }, [focusShotId, setFocusShotId]);
  useEffect(() => { if (pendingSourceId) { setSourceId(pendingSourceId); setPendingSourceId(null); } }, [pendingSourceId, setPendingSourceId]);

  // Default provider: first configured, preferring the free allocation.
  useEffect(() => {
    if (providerId && providers.some(p => p.id === providerId)) return;
    const pick = providers.find(p => p.configured && p.billing === "self-hosted") ?? providers.find(p => p.configured && p.billing === "free-allocation") ?? providers.find(p => p.configured) ?? providers[0];
    if (pick) setProviderId(pick.id);
  }, [providers, providerId]);

  const provider = providers.find(p => p.id === providerId);
  const imageCaps = provider?.kind === "image" ? provider.caps : null;
  const videoCaps = provider?.kind === "video" ? provider.caps : null;

  // Keep settings valid for the chosen provider.
  useEffect(() => {
    if (imageCaps) {
      if (!imageCaps.aspectRatios.includes(aspect)) setAspect(imageCaps.aspectRatios.includes("16:9") ? "16:9" : imageCaps.aspectRatios[0]);
      if (imageCaps.sizes.length && !imageCaps.sizes.includes(size)) setSize(imageCaps.sizes[0]);
    }
    if (videoCaps) {
      if (!videoCaps.durations.includes(duration)) setDuration(videoCaps.durations.includes(5) ? 5 : videoCaps.durations[0]);
      if (videoCaps.resolutions.length && !videoCaps.resolutions.includes(resolution)) setResolution(videoCaps.resolutions.includes("720p") ? "720p" : videoCaps.resolutions[0]);
      if (videoCaps.aspectRatios.length && !videoCaps.aspectRatios.includes(aspect)) setAspect(videoCaps.aspectRatios[0]);
    }
  }, [imageCaps, videoCaps, aspect, size, duration, resolution]);

  const shot = project.shots.find(s => s.id === shotId);
  const bundle = useMemo(() => buildContinuityBundle(project, shot ? { shotId: shot.id } : manual), [project, shot, manual]);

  // Reference candidates in priority order: primary identity per character, wardrobe, location angle, location, shot refs.
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const c of bundle.characters) for (const r of c.referenceImages) out.push({ assetId: r.assetId, label: `${c.name} — ${r.role === "wardrobe" ? `${c.wardrobe.name} wardrobe` : "identity"}`, role: ROLE_MAP[r.role], primary: r.primary });
    if (bundle.location) for (const r of bundle.location.referenceImages) out.push({ assetId: r.assetId, label: `${bundle.location.name} — ${r.role === "location-angle" ? bundle.location.angle?.name ?? "angle" : "location"}`, role: ROLE_MAP[r.role], primary: r.primary });
    for (const r of bundle.additionalReferences) out.push({ assetId: r.assetId, label: `Shot reference — ${r.name}`, role: "shot", primary: false });
    const seen = new Set<ID>();
    const unique = out.filter(c => (seen.has(c.assetId) ? false : (seen.add(c.assetId), true)));
    const rank = (c: Candidate) => (c.primary ? 0 : c.role === "character" ? 1 : c.role === "wardrobe" ? 2 : c.role === "location-angle" ? 3 : c.role === "location" ? 4 : 5);
    return unique.sort((a, b) => rank(a) - rank(b));
  }, [bundle]);

  const maxRefs = Math.max(0, (imageCaps?.maxReferences ?? videoCaps?.maxReferences ?? 0) - (isImage && sourceId ? 1 : 0));
  const videoUsesRefs = !isImage && !sourceId;
  const refsAllowed = isImage ? maxRefs : videoUsesRefs ? maxRefs : 0;
  const chosenRefs = (selectedRefs ?? candidates.map(c => c.assetId)).filter(id => candidates.some(c => c.assetId === id)).slice(0, refsAllowed);

  const imageAssets = project.assets.filter(a => a.kind === "image");
  const shotTakes = shot ? shot.generatedAssetIds.map(id => assetById(project, id)).filter((a): a is Asset => !!a && a.kind === "image") : [];
  const source = sourceId ? assetById(project, sourceId) : undefined;
  const history = ai.generations.filter(g => g.type === mode);

  function fillPrompt() {
    setPrompt(continuityPrompt(bundle, ""));
  }
  useEffect(() => {
    if (shot && !prompt) setPrompt(continuityPrompt(buildContinuityBundle(project, { shotId: shot.id }), ""));
    // only when the shot changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot?.id]);

  const costLine = (() => {
    if (!provider) return "";
    if (videoCaps?.costPerSecond) {
      const rate = videoCaps.costPerSecond[resolution] ?? videoCaps.costPerSecond.default;
      if (rate) return `Estimated cost ≈ $${(rate * duration).toFixed(2)} (${duration}s). ${provider.costNote}`;
    }
    return provider.costNote;
  })();

  async function generate() {
    if (!provider) return;
    setError("");
    if (!provider.configured) { setError(`${provider.label} is not configured. See Settings → AI providers.`); return; }
    if (!prompt.trim()) { setError("Write or fill a prompt first."); return; }
    if (!isImage && !sourceId && !videoCaps?.textToVideo) { setError("This provider needs a start image."); return; }
    if (provider.billing === "paid" && !confirm(`${provider.label} is a PAID service.\n\n${costLine}\n\nCharges go to your ${provider.vendor} account. Generate now?`)) return;
    setBusy(true);
    try {
      const refMax = imageCaps?.referenceMaxSide ?? 1536;
      const refs: ReferenceInput[] = [];
      for (const id of chosenRefs) {
        const a = assetById(project, id);
        const c = candidates.find(x => x.assetId === id);
        if (a && c) refs.push(await prepareImage(project.id, a, refMax, c.role, c.label));
      }
      const src = source ? await prepareImage(project.id, source, isImage ? refMax : videoCaps?.imageMaxSide ?? 1920, isImage ? "source" : "start-frame", source.name) : null;
      const label = shot ? `Shot ${shotNumber(project, shot)} ${mode}` : `${isImage ? "Image" : "Video"} ${new Date().toLocaleString().replace(/[/:]/g, "-")}`;
      await aiApi.generate(project.id, {
        type: mode, providerId: provider.id, prompt, negativePrompt: negative, references: refs, sourceImage: src, shotId: shot?.id ?? null,
        approvedPaid: provider.billing === "paid", label,
        imageSettings: isImage ? { aspectRatio: aspect, size: imageCaps?.sizes.length ? size : undefined, steps: steps === "" ? undefined : steps, seed: seed === "" ? undefined : seed, guidance: guidance === "" ? undefined : guidance, count } : undefined,
        videoSettings: isImage ? undefined : { aspectRatio: videoCaps?.aspectRatios.length ? aspect : undefined, durationSec: duration, resolution, generateAudio: audio },
      });
      notify(`${isImage ? "Image" : "Video"} generation started with ${provider.label}.`);
      await ai.refreshGenerations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation could not start.");
    } finally {
      setBusy(false);
    }
  }

  function loadFrom(g: GenerationView) {
    setProviderId(g.providerId);
    setPrompt(g.prompt);
    setNegative(g.negativePrompt);
    if (g.shotId && project.shots.some(s => s.id === g.shotId)) setShotId(g.shotId);
    if (g.sourceAssetId && assetById(project, g.sourceAssetId)) setSourceId(g.sourceAssetId);
    if (g.imageSettings) { setAspect(g.imageSettings.aspectRatio); if (g.imageSettings.size) setSize(g.imageSettings.size); setSeed(g.imageSettings.seed ?? ""); setSteps(g.imageSettings.steps ?? ""); setCount(g.imageSettings.count ?? 1); }
    if (g.videoSettings) { setDuration(g.videoSettings.durationSec); if (g.videoSettings.resolution) setResolution(g.videoSettings.resolution); if (g.videoSettings.aspectRatio) setAspect(g.videoSettings.aspectRatio); }
    setSelectedRefs(g.references.map(r => r.assetId));
    notify("Settings loaded from that generation. Review and press Generate to run it again.");
  }

  const shotOptions = (
    <>
      <option value="">— No shot: choose references manually —</option>
      {project.scenes.map(sc => {
        const list = project.shots.filter(s => s.sceneId === sc.id);
        return list.length ? <optgroup key={sc.id} label={sceneLabel(project, sc)}>{list.map(s => <option key={s.id} value={s.id}>Shot {shotNumber(project, s)}{s.title ? ` · ${s.title}` : ""}</option>)}</optgroup> : null;
      })}
      {project.shots.some(s => !s.sceneId) && <optgroup label="Unassigned">{project.shots.filter(s => !s.sceneId).map(s => <option key={s.id} value={s.id}>Shot {shotNumber(project, s)}{s.title ? ` · ${s.title}` : ""}</option>)}</optgroup>}
    </>
  );

  return (
    <div className="content">
      <div className="section-head">
        <div>
          <span className="eyebrow">{isImage ? "CREATE YOUR VISUALS" : "BRING SHOTS TO LIFE"}</span>
          <h3>{isImage ? "Image generation" : "Video generation"}</h3>
          <p>{isImage ? "Generate frames from a shot with its character and location references." : "Animate a frame (image-to-video) or generate from text."}</p>
        </div>
        {provider && <span className={`connection-pill${provider.configured ? "" : " warn"}`}>{provider.configured ? `${provider.vendor} · ${billingLabel(provider.billing)}` : "not configured"}</span>}
      </div>

      {ai.providersError && <p className="error-text">{ai.providersError}</p>}

      <div className="generator-layout">
        <div className="panel">
          <label>PROVIDER / MODEL
            <select className="field" value={providerId} onChange={e => { setProviderId(e.target.value); setSelectedRefs(null); }}>
              {providers.map(p => <option key={p.id} value={p.id}>{p.label} — {billingLabel(p.billing)}{p.configured ? "" : " (not configured)"}</option>)}
            </select>
          </label>
          {provider && (
            <div className={`provider-note${provider.kind === "image" && provider.caps.maxReferences === 0 ? " warn" : ""}`}>
              <strong>{(provider.kind === "image" ? provider.caps.maxReferences : provider.caps.maxReferences + (provider.caps.imageToVideo ? 1 : 0)) > 0 ? "Reference-conditioned" : "Text-only"}</strong>
              <span>{provider.conditioning}</span>
              <small>{costLine}</small>
              {!provider.configured && <small className="warn-text">Needs {provider.requirements.join(", ")}. <button className="text-button" onClick={() => go("Settings")}>Setup ↗</button></small>}
            </div>
          )}

          <label>SHOT
            <select className="field" value={shotId} onChange={e => { setShotId(e.target.value); setSelectedRefs(null); setPrompt(""); }}>{shotOptions}</select>
          </label>
          {!shot && <ContinuityPicker value={manual} onChange={patch => { setManual(m => ({ ...m, ...patch })); setSelectedRefs(null); }} />}

          <div className="continuity-box">
            <strong>Reference images {refsAllowed > 0 ? `(${chosenRefs.length}/${refsAllowed} sent)` : "(not used)"}</strong>
            {!isImage && sourceId && <p className="small">With a start frame, the video is conditioned on that image; reference images are not sent.</p>}
            {refsAllowed === 0 && (isImage || !sourceId) && <p className="small">This model does not accept reference images, so consistency depends on the text alone and is <b>not</b> reliable.</p>}
            {candidates.length === 0 && <p className="small">No reference images for the selected characters/location. Add images in the Characters and Locations libraries.</p>}
            <div className="ref-pick-grid">
              {candidates.map(c => {
                const a = assetById(project, c.assetId);
                const on = chosenRefs.includes(c.assetId);
                const full = !on && chosenRefs.length >= refsAllowed;
                return a ? (
                  <button key={c.assetId} type="button" className={`ref-pick${on ? " on" : ""}`} disabled={refsAllowed === 0 || full}
                    title={full ? `This model accepts ${refsAllowed} references` : c.label}
                    onClick={() => setSelectedRefs(on ? chosenRefs.filter(x => x !== c.assetId) : [...chosenRefs, c.assetId])}>
                    <AssetPreview asset={a} /><span>{c.label}</span>
                  </button>
                ) : null;
              })}
            </div>
            <small>References are downscaled in your browser and sent with the request. They help the model keep faces, clothing and locations consistent, but no current model guarantees identical results.</small>
          </div>

          {(isImage ? imageCaps?.imageToImage : videoCaps?.imageToVideo) && (
            <label>{isImage ? "SOURCE IMAGE (IMAGE-TO-IMAGE, OPTIONAL)" : "START FRAME (IMAGE-TO-VIDEO)"}
              <select className="field" value={sourceId} onChange={e => setSourceId(e.target.value)}>
                <option value="">{isImage ? "None — generate from text + references" : videoCaps?.textToVideo ? "None — text-to-video" : "— choose an image —"}</option>
                {shotTakes.length > 0 && <optgroup label="This shot's generated takes">{shotTakes.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>}
                <optgroup label="All project images">{imageAssets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>
              </select>
            </label>
          )}
          {source && <div className="source-preview"><AssetPreview asset={source} /><button className="tiny-button" onClick={() => setSourceId("")}>Clear</button></div>}

          <label>{isImage ? "PROMPT (SENT TO THE MODEL — EDIT FREELY)" : "MOTION PROMPT (SENT TO THE MODEL)"}
            <textarea className="field prompt-editor" value={prompt} onChange={e => setPrompt(e.target.value)}
              placeholder={isImage ? "Describe the frame: subject, action, composition, lens, lighting…" : "Describe subject motion, camera movement, atmosphere…"} />
          </label>
          <div className="button-row"><button className="button secondary" onClick={fillPrompt}>Fill from shot &amp; continuity</button></div>
          {(imageCaps?.negativePrompt || videoCaps?.negativePrompt) && (
            <label>NEGATIVE PROMPT (OPTIONAL)<input className="field" value={negative} onChange={e => setNegative(e.target.value)} placeholder="blur, distorted hands, text, watermark" /></label>
          )}

          <div className="form-grid three">
            {imageCaps && <>
              <label>ASPECT RATIO<select className="field" value={aspect} onChange={e => setAspect(e.target.value)}>{imageCaps.aspectRatios.map(r => <option key={r}>{r}</option>)}</select></label>
              {imageCaps.sizes.length > 0 && <label>SIZE<select className="field" value={size} onChange={e => setSize(e.target.value)}>{imageCaps.sizes.map(r => <option key={r}>{r}</option>)}</select></label>}
              <label>IMAGES<select className="field" value={count} onChange={e => setCount(Number(e.target.value))}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
              {imageCaps.steps && <label>STEPS<input className="field" type="number" min={imageCaps.steps.min} max={imageCaps.steps.max} placeholder={String(imageCaps.steps.default)} value={steps} onChange={e => setSteps(e.target.value === "" ? "" : Number(e.target.value))} /></label>}
              {imageCaps.seed && <label>SEED<input className="field" type="number" min={0} placeholder="random" value={seed} onChange={e => setSeed(e.target.value === "" ? "" : Math.max(0, Math.floor(Number(e.target.value))))} /></label>}
              {imageCaps.guidance && <label>GUIDANCE<input className="field" type="number" step={0.5} min={0} max={20} placeholder="default" value={guidance} onChange={e => setGuidance(e.target.value === "" ? "" : Number(e.target.value))} /></label>}
            </>}
            {videoCaps && <>
              <label>DURATION<select className="field" value={duration} onChange={e => setDuration(Number(e.target.value))}>{videoCaps.durations.map(d => <option key={d} value={d}>{d}s</option>)}</select></label>
              {videoCaps.aspectRatios.length > 0 && <label>ASPECT RATIO<select className="field" value={aspect} onChange={e => setAspect(e.target.value)}>{videoCaps.aspectRatios.map(r => <option key={r}>{r}</option>)}</select></label>}
              {videoCaps.resolutions.length > 0 && <label>RESOLUTION<select className="field" value={resolution} onChange={e => setResolution(e.target.value)}>{videoCaps.resolutions.map(r => <option key={r}>{r}</option>)}</select></label>}
              {provider?.id === "fal" && sourceId && <label className="check inline"><input type="checkbox" checked={audio} onChange={e => setAudio(e.target.checked)} /><span>Generate audio</span></label>}
            </>}
          </div>

          {error && <p className="error-text">{error}</p>}
          <div className="button-row">
            <button className="button primary" disabled={busy || !provider} onClick={generate}>
              {busy ? "Preparing…" : `${provider?.billing === "paid" ? "Generate (paid) ↗" : "Generate ↗"}`}
            </button>
            <button className="button secondary" onClick={() => navigator.clipboard.writeText(JSON.stringify(bundle, null, 2)).then(() => notify("Continuity JSON copied."), () => notify("Copy failed."))}>Copy continuity JSON</button>
          </div>
        </div>

        <div className="panel side-info">
          <div className="panel-head"><h3>Generations</h3><button className="text-button" onClick={() => void ai.refreshGenerations()}>Refresh</button></div>
          {history.length === 0 && <p className="muted small">No {mode} generations yet in this project.</p>}
          <div className="stack">
            {history.slice(0, 30).map(g => renderCard(g))}
          </div>
        </div>
      </div>
    </div>
  );

  // A render helper (not a nested component) so cards are not remounted on every poll.
  function renderCard(g: GenerationView) {
    const onLoad = () => loadFrom(g);
    const onSource = (id: ID) => setSourceId(id);
    const gShot = project.shots.find(s => s.id === g.shotId);
    return (
      <div key={g.id} className={`gen-card ${g.status}`}>
        <div className="gen-head">
          <span className={`status-pill ${g.status}`}>{g.status === "running" ? "Running" : g.status === "succeeded" ? "Done" : "Failed"}</span>
          <small className="muted">{g.providerLabel} · {timeAgo(g.createdAt)}</small>
        </div>
        {gShot && <small className="muted">Shot {shotNumber(project, gShot)}{gShot.title ? ` · ${gShot.title}` : ""}</small>}
        <p className="gen-prompt" title={g.prompt}>{g.prompt}</p>
        {g.status === "running" && <p className="small">{g.progress ?? "Working…"}</p>}
        {g.error && <p className="error-text small">{g.error}</p>}
        {g.notes && g.status !== "running" && <p className="muted small">{g.notes.slice(0, 300)}</p>}
        {g.outputs.length > 0 && (
          <div className="gen-outputs">
            {g.outputs.map(o => {
              const inProject = assetById(project, o.id);
              return (
                <div key={o.id} className="gen-output">
                  {inProject ? <AssetPreview asset={inProject} controls={o.kind === "video"} /> : o.kind === "image"
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img className="asset-preview" src={fileUrl(project.id, o.id)} alt={o.name} />
                    : <video className="asset-preview" src={fileUrl(project.id, o.id)} controls preload="metadata" />}
                  {!inProject && <small className="muted">Deleted from library</small>}
                  {inProject && o.kind === "image" && (
                    <span className="row-actions">
                      {isImage && <button className="tiny-button" onClick={() => onSource(o.id)}>Use as source</button>}
                      {isImage && <button className="tiny-button" onClick={() => { setPendingSourceId(o.id); if (g.shotId) setFocusShotId(g.shotId); go("Video Studio"); }}>Animate ↗</button>}
                      {!isImage && <button className="tiny-button" onClick={() => onSource(o.id)}>Use as start frame</button>}
                      {g.shotId && gShot && !gShot.assetIds.includes(o.id) && (
                        <button className="tiny-button" onClick={() => ws.mutate(d => { const s = d.shots.find(x => x.id === g.shotId); if (s && !s.assetIds.includes(o.id)) s.assetIds.push(o.id); }, `Added a generated frame to shot ${shotNumber(project, gShot)} references`)}>Add to shot refs</button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {g.status !== "running" && <div className="button-row"><button className="tiny-button" onClick={onLoad}>{g.status === "failed" ? "Retry with these settings" : "Regenerate / iterate"}</button></div>}
      </div>
    );
  }
}
