"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { aiApi } from "@/lib/client/ai";
import { sceneLabel, timeAgo } from "@/lib/projectModel";
import { splitChatReply } from "@/lib/proposals";
import type { Conversation } from "@/lib/ai/types";
import type { ID } from "@/lib/types";
import { Dropdown } from "./Dropdown";
import { ProposalCard } from "./ProposalCard";
import { useStudio } from "./studio";

const AUTO_SPEAK_KEY = "wonderboy-auto-speak";

/** Plain text for speech: drop proposal blocks, code fences and markdown symbols. */
function speakable(text: string) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_>`~-]{1,3}/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
}

export function CompanionView() {
  const { ws, project, notify, ai, go } = useStudio();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0); // seconds the current reply has taken
  const [pending, setPending] = useState(""); // the message being sent, shown until the reply arrives
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setWaited(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const [error, setError] = useState("");
  const [focusSceneId, setFocusSceneId] = useState<ID | "">("");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recognition = useRef<SpeechRecognition | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const llmReady = !!ai.providers?.activeLlm;
  const llmInfo = ai.providers?.llm.find(l => l.id === ai.providers?.activeLlm);
  const active = conversations.find(c => c.id === activeId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await aiApi.conversations(project.id);
      setConversations(list);
      setActiveId(id => (id && list.some(c => c.id === id) ? id : list[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load conversations");
    } finally {
      setLoading(false);
    }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    try { setAutoSpeak(localStorage.getItem(AUTO_SPEAK_KEY) === "1"); } catch { /* ignore */ }
    return () => { recognition.current?.abort?.(); window.speechSynthesis?.cancel(); };
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [active?.messages.length, busy]);

  function speak(text: string) {
    if (!("speechSynthesis" in window)) { notify("Speech output is not supported in this browser."); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(speakable(text));
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  }

  async function newConversation() {
    try {
      const c = await aiApi.createConversation(project.id);
      setConversations(list => [c, ...list]);
      setActiveId(c.id);
      return c;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create conversation");
      return null;
    }
  }

  async function send(textOverride?: string) {
    const message = (textOverride ?? input).trim();
    if (!message || busy) return;
    setError("");
    setWaited(0);
    setBusy(true);
    setPending(message);
    setInput("");
    setInterim("");
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const conv = active ?? (await newConversation());
      if (!conv) { setInput(message); return; }
      await ws.saveNow(); // the server reads the saved project as context
      const scene = project.scenes.find(s => s.id === focusSceneId);
      const res = await aiApi.send(project.id, conv.id, message, { sceneId: scene?.id ?? null, scriptId: scene?.scriptId ?? null }, ctrl.signal);
      setConversations(list => [res.conversation, ...list.filter(c => c.id !== res.conversation.id)]);
      setActiveId(res.conversation.id);
      const reply = res.conversation.messages[res.conversation.messages.length - 1];
      if (autoSpeak && reply?.role === "assistant") speak(reply.content);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : "The assistant could not answer.");
      setInput(cur => cur.trim() ? cur : message); // not sent: give the text back (unless they already typed something new)
    } finally {
      setPending("");
      abort.current = null;
      setBusy(false);
    }
  }

  function toggleMic() {
    if (listening) { recognition.current?.stop(); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { notify("Speech recognition is not supported in this browser. Try Chrome or Edge."); return; }
    const r = new Recognition();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true;
    const base = input ? `${input.trim()} ` : "";
    let finalText = "";
    r.onresult = (event: SpeechRecognitionEvent) => {
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else partial += res[0].transcript;
      }
      setInput(base + finalText);
      setInterim(partial);
    };
    r.onerror = (e: Event) => {
      const code = (e as Event & { error?: string }).error;
      notify(code === "not-allowed" ? "Microphone permission was denied." : `Voice input error${code ? `: ${code}` : ""}.`);
    };
    r.onend = () => { setListening(false); setInterim(""); };
    recognition.current = r;
    r.start();
    setListening(true);
  }

  const chips: [string, string][] = [
    ["Brainstorm the story", "Brainstorm three directions this story could take, with the emotional core of each."],
    ["Develop a scene", "Help me develop the focused scene: what is the conflict, what changes, and how should it end?"],
    ["Write dialogue", "Write dialogue for the focused scene and propose it as a scene update."],
    ["Plan shots", "Plan a cinematic shot list for the focused scene and propose the shots."],
    ["Suggest characters", "Who else does this story need? Propose characters with detailed visual descriptions."],
  ];

  return (
    <div className="content companion-layout">
      <aside className="panel conv-list">
        <div className="panel-head"><h3>Conversations</h3><button className="text-button" onClick={() => void newConversation()}>+ New</button></div>
        {loading && <p className="muted small">Loading…</p>}
        {!loading && conversations.length === 0 && <p className="muted small">No conversations yet. Send a message to start one.</p>}
        {conversations.map(c => (
          <div key={c.id} className={`list-item conv-item${c.id === activeId ? " active" : ""}`}>
            <button className="conv-open" onClick={() => setActiveId(c.id)}>
              <strong>{c.title}</strong><small>{c.messages.length} messages · {timeAgo(c.updatedAt)}</small>
            </button>
            <span className="conv-actions">
              <button className="tiny-button" title="Rename" onClick={async () => {
                const t = prompt("Conversation title", c.title);
                if (!t?.trim()) return;
                await aiApi.renameConversation(project.id, c.id, t).catch(() => notify("Rename failed"));
                setConversations(list => list.map(x => (x.id === c.id ? { ...x, title: t.trim() } : x)));
              }}>✎</button>
              <button className="tiny-button danger-text" title="Delete" onClick={async () => {
                if (!confirm(`Delete conversation “${c.title}”?`)) return;
                await aiApi.deleteConversation(project.id, c.id).catch(() => notify("Delete failed"));
                setConversations(list => list.filter(x => x.id !== c.id));
                if (activeId === c.id) setActiveId(null);
              }}>✕</button>
            </span>
          </div>
        ))}
      </aside>

      <div className="panel chat-panel">
        <div className="panel-head">
          <div><h3>{active?.title ?? "Creative companion"}</h3><p className="muted">Knows this project&apos;s scripts, scenes, characters and locations.</p></div>
          <span className="connection-pill">{llmInfo ? `${llmInfo.label} · ${llmInfo.model}` : "No text provider"}</span>
        </div>

        {!llmReady && ai.providers && (
          <div className="setup-note">
            <strong>Connect a text AI provider to chat.</strong>
            <p>Add <code>GEMINI_API_KEY</code> (Google AI Studio, free tier) to <code>.env.local</code> and restart the server. Other options are in Settings → AI providers.</p>
            <button className="text-button" onClick={() => go("Settings")}>Open provider settings ↗</button>
          </div>
        )}

        <div className="chat-messages">
          {(!active || active.messages.length === 0) && (
            <div className="chat-message assistant"><span>WB</span><p>Tell me your film idea, or ask me to develop a scene, write dialogue, plan shots or design characters. When I suggest changes, you can review them before they are added to the project.</p></div>
          )}
          {active?.messages.map(m => {
            const { text, proposals } = m.role === "assistant" ? splitChatReply(m.content, project) : { text: m.content, proposals: [] };
            return (
              <div className={`chat-message ${m.role}`} key={m.id}>
                <span>{m.role === "assistant" ? "WB" : "YOU"}</span>
                <p>{text || (proposals.length ? "Here is a suggestion:" : "")}</p>
                {proposals.map((p, i) => <ProposalCard key={i} proposal={p} targetSceneId={focusSceneId || null} />)}
                {m.role === "assistant" && <button className="tiny-button" onClick={() => speak(text)}>▶ Read aloud</button>}
              </div>
            );
          })}
          {pending && <div className="chat-message user"><span>YOU</span><p>{pending}</p></div>}
          {busy && <div className="muted">Thinking… {waited} s{waited >= 15 ? " (the AI may be busy; Wonderboy retries by itself, or press Cancel)" : ""}</div>}
          <div ref={bottom} />
        </div>

        {error && <p className="error-text">{error} <button className="text-button" onClick={() => void send()}>Retry</button></p>}

        <div className="chat-compose">
          <button className={`icon-button${listening ? " live" : ""}`} title={listening ? "Stop listening" : "Speak"} onClick={toggleMic}>{listening ? "■" : "🎙"}</button>
          <textarea rows={2} value={input + (interim ? ` ${interim}` : "")} onChange={e => { setInput(e.target.value); setInterim(""); }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={listening ? "Listening…" : "Ask about your story… (Enter to send, Shift+Enter for a new line)"} />
          {busy
            ? <button className="button secondary" onClick={() => abort.current?.abort()} title="Stop waiting for this reply; nothing is saved">Cancel</button>
            : <button className="button primary" onClick={() => void send()} disabled={!llmReady || !input.trim()}>Send ↗</button>}
        </div>
        <div className="chat-options">
          <label className="check inline"><input type="checkbox" checked={autoSpeak} onChange={e => { setAutoSpeak(e.target.checked); try { localStorage.setItem(AUTO_SPEAK_KEY, e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} /><span>Speak replies aloud</span></label>
          {speaking && <button className="tiny-button" onClick={() => { window.speechSynthesis.cancel(); setSpeaking(false); }}>■ Stop speaking</button>}
          <small className="muted">Voice uses your browser&apos;s speech recognition and synthesis.</small>
        </div>
      </div>

      <div className="panel side-info">
        <h3>Context</h3>
        <label>FOCUS ON SCENE
          <Dropdown value={focusSceneId} onChange={v => setFocusSceneId(v)}
            options={[{ value: "", label: "Whole project" }, ...project.scenes.map(s => ({ value: s.id, label: sceneLabel(project, s) }))]} />
        </label>
        <p className="muted small">The assistant sees the saved project: {project.scripts.length} scripts, {project.scenes.length} scenes, {project.characters.length} characters, {project.locations.length} locations.</p>
        <h3>Try asking</h3>
        {chips.map(([label, text]) => <button key={label} className="prompt-chip" disabled={!llmReady || busy} onClick={() => void send(text)}>{label} ↗</button>)}
      </div>
    </div>
  );
}
