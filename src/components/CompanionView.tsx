"use client";
import { useEffect, useRef, useState } from "react";
import { useStudio } from "./studio";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export const WELCOME: ChatMessage = {
  role: "assistant",
  content: "Welcome to Wonderboy Studio. Tell me your film idea, or ask me to develop a scene, character, or shot.",
};

/** Chat with the creative companion. Chat history is owned by the page so it survives tab switches. */
export function CompanionView({ chat, setChat }: { chat: ChatMessage[]; setChat: React.Dispatch<React.SetStateAction<ChatMessage[]>> }) {
  const { project, notify } = useStudio();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVoiceSupported("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [chat, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setChat(c => [...c, { role: "user", content: message }]);
    setInput("");
    setBusy(true);
    try {
      const context = {
        name: project.name,
        logline: project.logline,
        style: project.style,
        script: (project.scripts[0]?.content ?? "").slice(0, 20000),
        scenes: project.scenes.map(s => s.heading || s.title).filter(Boolean).slice(0, 100),
        characters: project.characters.map(c => c.name),
        locations: project.locations.map(l => l.name),
      };
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, project: context }) });
      const data = await res.json();
      setChat(c => [...c, { role: "assistant", content: data.reply || data.error || "No response received." }]);
    } catch {
      setChat(c => [...c, { role: "assistant", content: "I couldn't reach the assistant. Add GEMINI_API_KEY to .env.local and restart the app. Your project is still saved." }]);
    } finally {
      setBusy(false);
    }
  }

  function startVoice() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { notify("Speech recognition is not supported in this browser. Try Chrome."); return; }
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event: SpeechRecognitionEvent) => setInput(event.results[0][0].transcript);
    recognition.onerror = () => notify("Microphone recognition failed. Check browser microphone permission.");
    recognition.start();
    notify("Listening… your words will appear in the message box.");
  }

  function readAloud(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  const chips: [string, string][] = [
    ["Develop a film idea", "Help me develop this film idea into a compelling short story."],
    ["Write a screenplay scene", "Help me write a screenplay scene with natural dialogue."],
    ["Plan cinematic shots", "Break this scene into cinematic shots with camera directions."],
    ["Design a character and world", "Help me design a memorable character and a consistent location."],
  ];

  return (
    <div className="content split-chat">
      <div className="panel chat-panel">
        <div className="panel-head"><div><h3>Creative companion</h3><p className="muted">A writing partner for your film ideas</p></div><span className="connection-pill">Gemini · optional</span></div>
        <div className="chat-messages">
          {chat.map((m, i) => (
            <div className={`chat-message ${m.role}`} key={i}>
              <span>{m.role === "assistant" ? "WB" : "YOU"}</span>
              <p>{m.content}</p>
              {m.role === "assistant" && <button className="tiny-button" onClick={() => readAloud(m.content)}>▶ Read aloud</button>}
            </div>
          ))}
          {busy && <div className="muted">Thinking…</div>}
          <div ref={bottom} />
        </div>
        <div className="chat-compose">
          <button className="icon-button" title="Speak" onClick={startVoice}>🎙</button>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Tell me about your story…" />
          <button className="button primary" onClick={send} disabled={busy}>Send ↗</button>
        </div>
        <small className="muted">{voiceSupported ? "Microphone input supported in this browser." : "Voice input availability depends on your browser."} Spoken replies use your browser&apos;s speech synthesis.</small>
      </div>
      <div className="panel side-info">
        <h3>What can we work on?</h3>
        {chips.map(([label, text]) => <button key={label} className="prompt-chip" onClick={() => setInput(text)}>{label} ↗</button>)}
        <p className="muted small">Add GEMINI_API_KEY to .env.local to enable AI responses. Without it, the rest of the workspace still works.</p>
      </div>
    </div>
  );
}
