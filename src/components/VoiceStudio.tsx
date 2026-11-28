"use client";
import { useEffect, useMemo, useState } from "react";
import { aiApi, type GenerationView } from "@/lib/client/ai";
import { assetById, fileUrl, sceneLabel, shotNumber, timeAgo } from "@/lib/projectModel";
import type { AudioProviderInfo } from "@/lib/ai/types";
import type { ID } from "@/lib/types";
import { Dropdown } from "./Dropdown";
import { AudioPlayer, useStudio } from "./studio";

const DEVANAGARI = /[ऀ-ॿ]/;
const SAMPLES: Record<string, string> = {
  en: "Every story begins with a single moment. This one begins in a quiet room, just before sunrise.",
  hi: "हर कहानी एक छोटे से पल से शुरू होती है। यह कहानी सूरज उगने से ठीक पहले, एक शांत कमरे में शुरू होती है।",
};

/** Text-to-speech: narration and dialogue voiceovers saved to the project (and optionally a shot). */
export function VoiceStudio() {
  const { project, ai, notify, go } = useStudio();
  const providers = useMemo<AudioProviderInfo[]>(() => ai.providers?.audio ?? [], [ai.providers]);
  const [providerId, setProviderId] = useState("kokoro");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState(1);
  const [style, setStyle] = useState("");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [shotId, setShotId] = useState<ID | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const provider = providers.find(p => p.id === providerId) ?? providers[0];
  const caps = provider?.caps;
  const isHindi = DEVANAGARI.test(text);
  const hindiOnEnglishEngine = isHindi && provider && !provider.caps.languages.some(l => l.startsWith("Hindi"));

  // Keep a valid voice for the selected engine.
  useEffect(() => {
    if (caps && !caps.voices.some(v => v.id === voice)) setVoice(caps.voices[0]?.id ?? "");
  }, [caps, voice]);

  const history = ai.generations.filter(g => g.type === "audio");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const shot = project.shots.find(s => s.id === shotId);

  function fillFromScene(sceneId: string) {
    const s = project.scenes.find(x => x.id === sceneId);
    if (!s) return;
    setText(s.dialogue.trim() || s.description.trim());
    setTitle(`${s.heading || s.title || "Scene"} voiceover`);
  }

  async function generate(customText?: string, label?: string) {
    const body = (customText ?? text).trim();
    if (!provider) return;
    setError("");
    if (!provider.configured) { setError(`${provider.label} is not configured: ${provider.setup}`); return; }
    if (!body) { setError("Write or load some text first."); return; }
    if (!voice) { setError("Choose a voice."); return; }
    setBusy(true);
    try {
      await aiApi.generate(project.id, {
        type: "audio", providerId: provider.id, prompt: body, references: [], shotId: customText ? null : shot?.id ?? null,
        audioSettings: { voice, speed: caps?.speed ? speed : undefined, style: caps?.style ? style : undefined },
        label: label ?? (title.trim() || (shot ? `Shot ${shotNumber(project, shot)} voiceover` : `Voiceover ${new Date().toLocaleString().replace(/[/:]/g, "-")}`)),
      });
      notify(`Voice generation started with ${provider.label}.`);
      await ai.refreshGenerations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start voice generation.");
    } finally {
      setBusy(false);
    }
  }

  function loadFrom(g: GenerationView) {
    setProviderId(g.providerId);
    setText(g.prompt);
    if (g.audioSettings) { setVoice(g.audioSettings.voice); if (g.audioSettings.speed) setSpeed(g.audioSettings.speed); setStyle(g.audioSettings.style ?? ""); }
    if (g.shotId) setShotId(g.shotId);
    notify("Loaded that voiceover's text and settings.");
  }

  function renderJob(g: GenerationView) {
    const gShot = project.shots.find(s => s.id === g.shotId);
    return (
      <div key={g.id} className={`gen-card ${g.status}`}>
        <div className="gen-head">
          <span className={`status-pill ${g.status}`}>{g.status === "running" ? "Running" : g.status === "succeeded" ? "Done" : "Failed"}</span>
          <small className="muted">{g.providerLabel} · {g.audioSettings?.voice} · {timeAgo(g.createdAt)}</small>
        </div>
        {gShot && <small className="muted">Shot {shotNumber(project, gShot)}{gShot.title ? ` · ${gShot.title}` : ""}</small>}
        <p className="gen-prompt" title={g.prompt}>{g.prompt}</p>
        {g.status === "running" && <p className="small">{g.progress ?? "Working…"}</p>}
        {g.error && <p className="error-text small">{g.error}</p>}
        {g.outputs.map(o => (
          <div key={o.id} className="audio-output">
            <AudioPlayer src={fileUrl(project.id, o.id)} />
            <span className="row-actions">
              <a className="tiny-button" href={fileUrl(project.id, o.id)} download={o.name}>Download WAV</a>
              {!assetById(project, o.id) && <small className="muted">Deleted from library</small>}
            </span>
          </div>
        ))}
        {g.status !== "running" && <div className="button-row"><button className="tiny-button" onClick={() => loadFrom(g)}>{g.status === "failed" ? "Retry with these settings" : "Edit & regenerate"}</button></div>}
      </div>
    );
  }

  return (
    <div className="content">
      <div className="section-head">
        <div><span className="eyebrow">NARRATION &amp; DIALOGUE</span><h3>Voice studio</h3><p>Turn narration and dialogue into realistic speech. Audio is saved to the asset library and, if chosen, to a shot.</p></div>
        {provider && <span className={`connection-pill${provider.configured ? " ok" : " warn"}`}>{provider.caps.runsLocally ? "Free · runs locally" : provider.configured ? "Free tier · cloud" : "Not configured"}</span>}
      </div>

      <div className="generator-layout">
        <div className="panel">
          <div className="form-grid">
            <label>VOICE ENGINE
              <Dropdown value={provider?.id ?? ""} onChange={v => { setProviderId(v); setVoice(""); }}
                options={providers.map(p => ({ value: p.id, label: `${p.label}${p.configured ? "" : " (not configured)"}` }))} />
            </label>
            <label>VOICE
              <Dropdown value={voice} onChange={v => setVoice(v)}
                options={(caps?.voices ?? []).map(v => ({ value: v.id, label: v.label }))} />
            </label>
          </div>
          {provider && (
            <div className="provider-note">
              <strong>{provider.caps.languages.join(" · ")}</strong>
              <span>{provider.conditioning}</span>
              <small>{provider.costNote}</small>
              {!provider.configured && <small className="warn-text">Needs {provider.requirements.join(", ")}. <button className="text-button" onClick={() => go("Settings")}>Setup ↗</button></small>}
            </div>
          )}
          {hindiOnEnglishEngine && (
            <div className="setup-note">
              <strong>This text is in Hindi.</strong> {provider?.label} only speaks English.{" "}
              {providers.some(p => p.id === "gemini-tts") && <button className="text-button" onClick={() => { setProviderId("gemini-tts"); setVoice(""); }}>Switch to Gemini TTS ↗</button>}
            </div>
          )}

          <div className="form-grid">
            <label>LOAD TEXT FROM A SCENE
              <Dropdown value="" onChange={v => fillFromScene(v)}
                options={[{ value: "", label: "— choose a scene —" }, ...project.scenes.map(s => ({ value: s.id, label: sceneLabel(project, s) }))]} />
            </label>
            <label>ATTACH TO SHOT (OPTIONAL)
              <Dropdown value={shotId} onChange={v => setShotId(v)}
                options={[{ value: "", label: "— none (asset library only) —" }, ...project.shots.map(s => ({ value: s.id, label: `Shot ${shotNumber(project, s)}${s.title ? ` · ${s.title}` : ""}` }))]} />
            </label>
          </div>

          <label>TEXT TO SPEAK
            <textarea className="field prompt-editor tall" value={text} onChange={e => setText(e.target.value)}
              placeholder="Paste narration or dialogue. Blank lines become natural paragraph pauses." />
          </label>
          <p className="muted small">{words} words · about {Math.max(0, Math.round(words / 150 * 10) / 10)} min of speech · max {caps?.maxChars.toLocaleString()} characters</p>

          {caps?.inlineTags.length ? (
            <div className="chip-row tag-row">
              <span className="muted small">Insert:</span>
              {caps.inlineTags.map(t => <button key={t} type="button" className="chip" onClick={() => setText(x => `${x}${x && !x.endsWith(" ") ? " " : ""}${t} `)}>{t}</button>)}
            </div>
          ) : null}

          <div className="form-grid">
            {caps?.speed && (
              <label>SPEED · {speed.toFixed(2)}×
                <input className="range" type="range" min={caps.speed.min} max={caps.speed.max} step={0.05} value={speed} onChange={e => setSpeed(Number(e.target.value))} />
              </label>
            )}
            {caps?.style && (
              <label>DELIVERY / STYLE (OPTIONAL)
                <input className="field" value={style} onChange={e => setStyle(e.target.value)} placeholder="Warm, slow documentary narrator" />
              </label>
            )}
            <label>FILE NAME (OPTIONAL)
              <input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="Opening narration" />
            </label>
          </div>

          {error && <p className="error-text">{error}</p>}
          <div className="button-row">
            <button className="button primary" disabled={busy || !provider || !!hindiOnEnglishEngine} onClick={() => void generate()}>{busy ? "Starting…" : "Generate voice ↗"}</button>
            <button className="button secondary" disabled={busy || !provider} title="Generate a short sample with this voice"
              onClick={() => void generate(provider?.caps.languages.some(l => l.startsWith("Hindi")) && isHindi ? SAMPLES.hi : SAMPLES.en, `Voice sample - ${voice}`)}>
              Try this voice
            </button>
          </div>
        </div>

        <div className="panel side-info">
          <div className="panel-head"><h3>Voiceovers</h3><button className="text-button" onClick={() => void ai.refreshGenerations()}>Refresh</button></div>
          {history.length === 0 && <p className="muted small">No voiceovers yet. The first Kokoro run downloads its ~90 MB model, so it takes a little longer.</p>}
          <div className="stack">{history.slice(0, 30).map(renderJob)}</div>
        </div>
      </div>
    </div>
  );
}
