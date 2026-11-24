"use client";

import { useEffect, useMemo, useState } from "react";

type RefAsset = { id: string; name: string; kind: "character" | "location"; description: string; image?: string; createdAt: string };
type Shot = { id: string; title: string; scene: string; description: string; characterIds: string[]; locationId: string; status: string };
type Project = { name: string; logline: string; style: string; script: string; assets: RefAsset[]; shots: Shot[] };

const starter: Project = {
  name: "The Disturbance",
  logline: "A quiet man begins to notice small disturbances in his ordinary routine.",
  style: "Warm vintage 1970s film still, natural light, muted earthy colours, subtle film grain, grounded cinematic realism. No text or logos.",
  script: "",
  assets: [],
  shots: [
    { id: "s1", title: "Morning routine", scene: "Scene 01", description: "Wide establishing shot of the room in early morning light.", characterIds: [], locationId: "", status: "Planning" },
    { id: "s2", title: "A quiet pause", scene: "Scene 01", description: "Medium shot. The main character pauses and looks toward the window.", characterIds: [], locationId: "", status: "Planning" }
  ]
};

const STORAGE_KEY = "wonderboy-studio-project-v1";

export default function Home() {
  const [project, setProject] = useState<Project>(starter);
  const [tab, setTab] = useState("Overview");
  const [chatInput, setChatInput] = useState("");
  const [chat, setChat] = useState<{role:string; content:string}[]>([
    { role: "assistant", content: "Welcome to Wonderboy Studio. Tell me your film idea, or ask me to develop a scene, character, or shot." }
  ]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Local workspace · changes save in this browser");
  const [assetName, setAssetName] = useState("");
  const [assetDescription, setAssetDescription] = useState("");
  const [assetKind, setAssetKind] = useState<"character"|"location">("character");
  const [assetImage, setAssetImage] = useState("");
  const [shotTitle, setShotTitle] = useState("");
  const [shotDescription, setShotDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [generatedPrompt, setGeneratedPrompt] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try { setProject(JSON.parse(saved)); } catch {}
    }
    setVoiceSupported(typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  }, [project]);

  const characters = useMemo(() => project.assets.filter(a => a.kind === "character"), [project.assets]);
  const locations = useMemo(() => project.assets.filter(a => a.kind === "location"), [project.assets]);

  function update<K extends keyof Project>(key: K, value: Project[K]) {
    setProject(p => ({ ...p, [key]: value }));
  }

  function addAsset() {
    if (!assetName.trim()) return;
    const asset: RefAsset = { id: crypto.randomUUID(), name: assetName.trim(), kind: assetKind, description: assetDescription.trim(), image: assetImage || undefined, createdAt: new Date().toISOString() };
    update("assets", [...project.assets, asset]);
    setAssetName(""); setAssetDescription(""); setAssetImage("");
    setNotice(`${assetKind === "character" ? "Character" : "Location"} reference saved.`);
  }

  function addShot() {
    if (!shotTitle.trim()) return;
    update("shots", [...project.shots, { id: crypto.randomUUID(), title: shotTitle, scene: `Scene ${String(project.shots.length + 1).padStart(2,"0")}`, description: shotDescription, characterIds: [], locationId: "", status: "Planning" }]);
    setShotTitle(""); setShotDescription("");
  }

  async function sendChat() {
    if (!chatInput.trim() || busy) return;
    const message = chatInput.trim();
    setChat(c => [...c, { role: "user", content: message }]);
    setChatInput(""); setBusy(true);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, project: { name: project.name, logline: project.logline, style: project.style, script: project.script } }) });
      const data = await res.json();
      setChat(c => [...c, { role: "assistant", content: data.reply || data.error || "No response received." }]);
    } catch {
      setChat(c => [...c, { role: "assistant", content: "I couldn't reach the assistant. Add GEMINI_API_KEY to .env.local and restart the app. Your project is still saved locally." }]);
    } finally { setBusy(false); }
  }

  function startVoice() {
    const w = window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition; SpeechRecognition?: new () => SpeechRecognition };
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) { setNotice("Speech recognition is not supported in this browser. Try Chrome."); return; }
    const recognition = new Recognition();
    recognition.lang = "en-US"; recognition.interimResults = false;
    recognition.onresult = (event: SpeechRecognitionEvent) => setChatInput(event.results[0][0].transcript);
    recognition.onerror = () => setNotice("Microphone recognition failed. Check browser microphone permission.");
    recognition.start();
    setNotice("Listening… your words will appear in the message box.");
  }

  function readAloud(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  async function generate(kind: "image"|"video") {
    const p = prompt.trim();
    if (!p) { setNotice("Write a prompt first."); return; }
    setBusy(true);
    try {
      const endpoint = kind === "image" ? "/api/generate/image" : "/api/generate/video";
      const res = await fetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ prompt:p, projectStyle:project.style, references:project.assets.map(a=>({name:a.name,kind:a.kind,description:a.description,image:a.image})) }) });
      const data = await res.json();
      setNotice(data.message || data.error || "Request completed.");
    } catch { setNotice("Generation service is not configured yet. See docs/PROVIDERS.md."); }
    finally { setBusy(false); }
  }

  function preparePrompt() {
    const referenceText = project.assets.map(a => `${a.kind.toUpperCase()} ${a.name}: ${a.description}`).join("\n");
    const result = `${project.style}\n\nCONTINUITY REFERENCES:\n${referenceText || "No saved references yet."}\n\nSHOT PROMPT:\n${prompt}`;
    setGeneratedPrompt(result);
    setNotice("Continuity prompt prepared. Copy it into your configured image/video model.");
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g,"-") || "film"}-project.json`; a.click(); URL.revokeObjectURL(url);
  }

  const nav = ["Overview", "AI Companion", "Script", "Shots", "References", "Image Studio", "Video Studio", "Settings"];
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">W</span><div><b>WONDERBOY</b><small>AI FILM STUDIO</small></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="project-pill"><span className="dot"/> {project.name}</div>
        <nav>{nav.map(n => <button key={n} className={tab===n?"nav-item active":"nav-item"} onClick={()=>setTab(n)}><span className="nav-icon">{({Overview:"◫","AI Companion":"✳",Script:"≡",Shots:"▤",References:"◈","Image Studio":"▧","Video Studio":"▷",Settings:"⚙"} as Record<string,string>)[n]}</span>{n}</button>)}</nav>
        <div className="sidebar-bottom"><div className="status-dot"/> Local project storage <small>Provider connections optional</small></div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div><span className="eyebrow">YOUR CREATIVE WORKSPACE</span><h1>{tab}</h1></div><div className="top-actions"><span className="save-state">● Saved locally</span><button className="button secondary" onClick={exportProject}>Export project</button></div></header>

        {tab==="Overview" && <div className="content">
          <section className="hero"><div><span className="eyebrow gold">YOUR NEXT FILM STARTS HERE</span><h2>Make something<br/><em>worth watching.</em></h2><p>Develop the story. Build the world. Create every shot. Keep your visual continuity in one place.</p><button className="button primary" onClick={()=>setTab("AI Companion")}>Start creating <span>↗</span></button></div><div className="hero-art"><div className="film-frame"><div className="sun"/><div className="hill hill-one"/><div className="hill hill-two"/><div className="frame-caption">A STORY BY YOU</div></div></div></section>
          <div className="section-head"><div><span className="eyebrow">CURRENT PROJECT</span><h3>{project.name}</h3><p>{project.logline || "Add a logline to describe your film."}</p></div><button className="text-button" onClick={()=>setTab("Settings")}>Edit project ↗</button></div>
          <div className="stats-grid"><div className="stat-card"><span>CHARACTERS</span><b>{characters.length.toString().padStart(2,"0")}</b><small>Saved references</small></div><div className="stat-card"><span>LOCATIONS</span><b>{locations.length.toString().padStart(2,"0")}</b><small>Saved environments</small></div><div className="stat-card"><span>SHOTS</span><b>{project.shots.length.toString().padStart(2,"0")}</b><small>Planned shots</small></div><div className="stat-card"><span>SCRIPT</span><b>{project.script.trim()? "01":"00"}</b><small>Draft in progress</small></div></div>
          <div className="two-col"><div className="panel"><div className="panel-head"><h3>Creative workflow</h3><span className="muted">YOUR PROCESS</span></div>{[["01","Develop the story","Talk through the idea with your AI companion","AI Companion"],["02","Write the script","Build scenes, dialogue and narration","Script"],["03","Plan your shots","Turn scenes into a visual storyboard","Shots"],["04","Build visual references","Lock character and location continuity","References"]].map(x=><button className="workflow-row" key={x[0]} onClick={()=>setTab(x[3])}><b>{x[0]}</b><span><strong>{x[1]}</strong><small>{x[2]}</small></span><i>↗</i></button>)}</div><div className="panel note-panel"><span className="eyebrow gold">CONTINUITY FIRST</span><h3>Your film&apos;s visual memory.</h3><p>Save character and location references once. Reuse them across shots so your film feels like one coherent world.</p><button className="text-button" onClick={()=>setTab("References")}>Open reference library ↗</button></div></div>
        </div>}

        {tab==="AI Companion" && <div className="content split-chat"><div className="panel chat-panel"><div className="panel-head"><div><h3>Creative companion</h3><p className="muted">A writing partner for your film ideas</p></div><span className="connection-pill">Gemini · optional</span></div><div className="chat-messages">{chat.map((m,i)=><div className={`chat-message ${m.role}`} key={i}><span>{m.role==="assistant"?"WB":"YOU"}</span><p>{m.content}</p>{m.role==="assistant"&&<button className="tiny-button" onClick={()=>readAloud(m.content)}>▶ Read aloud</button>}</div>)}{busy&&<div className="muted">Thinking…</div>}</div><div className="chat-compose"><button className="icon-button" title="Speak" onClick={startVoice}>🎙</button><input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Tell me about your story…" /><button className="button primary" onClick={sendChat} disabled={busy}>Send ↗</button></div><small className="muted">{voiceSupported?"Microphone input supported in this browser.":"Voice input availability depends on your browser."} Spoken replies use your browser&apos;s speech synthesis.</small></div><div className="panel side-info"><h3>What can we work on?</h3><div className="prompt-chip" onClick={()=>setChatInput("Help me develop this film idea into a compelling short story.")}>Develop a film idea ↗</div><div className="prompt-chip" onClick={()=>setChatInput("Help me write a screenplay scene with natural dialogue.")}>Write a screenplay scene ↗</div><div className="prompt-chip" onClick={()=>setChatInput("Break this scene into cinematic shots with camera directions.")}>Plan cinematic shots ↗</div><div className="prompt-chip" onClick={()=>setChatInput("Help me design a memorable character and a consistent location.")}>Design a character and world ↗</div><p className="muted small">Add GEMINI_API_KEY to .env.local to enable AI responses. Without it, the rest of the workspace still works locally.</p></div></div>}

        {tab==="Script" && <div className="content"><div className="section-head"><div><span className="eyebrow">WRITE THE FILM</span><h3>Script room</h3><p>Keep your story, scenes and dialogue together.</p></div><button className="button secondary" onClick={()=>setTab("AI Companion")}>Ask AI for help ↗</button></div><div className="panel"><label>PROJECT TITLE<input className="field" value={project.name} onChange={e=>update("name",e.target.value)}/></label><label>LOGLINE<input className="field" value={project.logline} onChange={e=>update("logline",e.target.value)} placeholder="A one-sentence summary of your film"/></label><label>SCREENPLAY<textarea className="field script-editor" value={project.script} onChange={e=>update("script",e.target.value)} placeholder={"FADE IN:\n\nINT. ROOM - MORNING\n\nWrite your scene here..."} /></label><div className="editor-footer"><span className="muted">{project.script.trim().split(/\s+/).filter(Boolean).length} words · Autosaved locally</span><button className="button secondary" onClick={()=>setTab("Shots")}>Continue to shots ↗</button></div></div></div>}

        {tab==="Shots" && <div className="content"><div className="section-head"><div><span className="eyebrow">VISUAL BREAKDOWN</span><h3>Shot planner</h3><p>Break your script into individual, reusable shots.</p></div></div><div className="panel add-shot"><input className="field" value={shotTitle} onChange={e=>setShotTitle(e.target.value)} placeholder="Shot title"/><input className="field" value={shotDescription} onChange={e=>setShotDescription(e.target.value)} placeholder="Describe framing, action, camera movement…"/><button className="button primary" onClick={addShot}>Add shot +</button></div><div className="shot-list">{project.shots.map((s,i)=><div className="shot-card" key={s.id}><div className="shot-number">{String(i+1).padStart(2,"0")}</div><div className="shot-details"><span className="eyebrow">{s.scene}</span><h3>{s.title}</h3><p>{s.description}</p><div className="shot-meta"><span>{s.characterIds.length} character refs</span><span>{s.locationId?"Location linked":"No location linked"}</span><span>{s.status}</span></div></div><button className="text-button" onClick={()=>{setPrompt(`${s.title}. ${s.description}`);setTab("Image Studio")}}>Create image ↗</button><button className="tiny-button" onClick={()=>update("shots",project.shots.filter(x=>x.id!==s.id))}>Remove</button></div>)}</div></div>}

        {tab==="References" && <div className="content"><div className="section-head"><div><span className="eyebrow">VISUAL CONTINUITY LIBRARY</span><h3>Characters & locations</h3><p>Upload reference images or create reference concepts with an AI image provider.</p></div></div><div className="reference-layout"><div className="panel"><div className="panel-head"><h3>Add a reference</h3><span className="muted">UPLOAD OR DESCRIBE</span></div><label>REFERENCE TYPE<select className="field" value={assetKind} onChange={e=>setAssetKind(e.target.value as "character"|"location")}><option value="character">Character</option><option value="location">Location</option></select></label><label>NAME<input className="field" value={assetName} onChange={e=>setAssetName(e.target.value)} placeholder={assetKind==="character"?"e.g. Ramesh":"e.g. Ramesh's house"}/></label><label>CANONICAL DESCRIPTION<textarea className="field textarea-small" value={assetDescription} onChange={e=>setAssetDescription(e.target.value)} placeholder={assetKind==="character"?"Describe face, age appearance, hair, build, wardrobe, distinctive details…":"Describe architecture, room layout, materials, furniture, lighting, geography…"}/></label><label>UPLOAD REFERENCE IMAGE<input className="field file-field" type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(!f)return;const reader=new FileReader();reader.onload=()=>setAssetImage(String(reader.result));reader.readAsDataURL(f)}}/></label>{assetImage&&<img className="upload-preview" src={assetImage} alt="Reference preview"/>}<button className="button primary full" onClick={addAsset}>Save reference</button><p className="muted small">You can also create a reference image in Image Studio and upload it here. AI generation is enabled after connecting an image provider.</p></div><div className="reference-groups"><ReferenceGroup title="CHARACTERS" items={characters} onDelete={id=>update("assets",project.assets.filter(a=>a.id!==id))}/><ReferenceGroup title="LOCATIONS" items={locations} onDelete={id=>update("assets",project.assets.filter(a=>a.id!==id))}/></div></div></div>}

        {(tab==="Image Studio"||tab==="Video Studio") && <div className="content"><div className="section-head"><div><span className="eyebrow">{tab==="Image Studio"?"CREATE YOUR VISUALS":"BRING SHOTS TO LIFE"}</span><h3>{tab==="Image Studio"?"Image generation":"Video generation"}</h3><p>{tab==="Image Studio"?"Create character concepts, environments, props and storyboard frames.":"Generate motion from a prompt or a selected storyboard image."}</p></div><span className="connection-pill">Provider adapter · not connected</span></div><div className="generator-layout"><div className="panel"><label>{tab==="Image Studio"?"IMAGE PROMPT":"VIDEO / MOTION PROMPT"}<textarea className="field prompt-editor" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder={tab==="Image Studio"?"Describe the frame, composition, lens, lighting and action…":"Describe subject movement, camera movement, atmosphere and duration…"}/></label><div className="continuity-box"><strong>Continuity references included</strong><p>{project.assets.length?project.assets.map(a=>a.name).join(" · "):"No references saved yet. Add characters and locations in the References workspace."}</p><small>Saved reference descriptions are sent with the generation request. Image files are also included where supported by a configured adapter.</small></div><div className="button-row"><button className="button secondary" onClick={preparePrompt}>Prepare continuity prompt</button><button className="button primary" disabled={busy} onClick={()=>generate(tab==="Image Studio"?"image":"video")}>{busy?"Working…":`Generate ${tab==="Image Studio"?"image":"video"} ↗`}</button></div><label>PREPARED PROMPT<textarea className="field prompt-editor" value={generatedPrompt} onChange={e=>setGeneratedPrompt(e.target.value)} placeholder="Your combined style and continuity prompt will appear here."/></label><button className="button secondary" onClick={()=>navigator.clipboard.writeText(generatedPrompt)}>Copy prepared prompt</button></div><div className="panel side-info"><h3>Generation notes</h3><p>Generation is deliberately provider-independent. We have not connected a paid GPU or committed to one model.</p><ul className="plain-list"><li>Choose models based on quality, license and cost.</li><li>Keep provider keys on the server, never in browser code.</li><li>Use image references and image-to-image conditioning for stronger continuity.</li><li>Video generation may need a hosted GPU or a limited free runtime.</li></ul><button className="text-button" onClick={()=>setTab("Settings")}>Provider settings ↗</button></div></div></div>}

        {tab==="Settings" && <div className="content"><div className="section-head"><div><span className="eyebrow">PROJECT & CONNECTIONS</span><h3>Settings</h3><p>Configure your project identity and optional AI providers.</p></div></div><div className="settings-grid"><div className="panel"><h3>Project settings</h3><label>PROJECT NAME<input className="field" value={project.name} onChange={e=>update("name",e.target.value)}/></label><label>VISUAL STYLE / STYLE BIBLE<textarea className="field textarea-small" value={project.style} onChange={e=>update("style",e.target.value)}/></label><p className="muted small">This style bible is reused in image and video prompt preparation.</p></div><div className="panel"><h3>Provider connections</h3><div className="provider-row"><span className="provider-icon">✳</span><div><b>Google Gemini</b><small>Chat and script assistance</small></div><span className="connection-pill">API key optional</span></div><div className="provider-row"><span className="provider-icon">▧</span><div><b>Image provider</b><small>Connect a compatible hosted inference API</small></div><span className="connection-pill">Not connected</span></div><div className="provider-row"><span className="provider-icon">▷</span><div><b>Video provider</b><small>Connect a hosted video model API</small></div><span className="connection-pill">Not connected</span></div><p className="muted small">Set keys in .env.local. Read docs/PROVIDERS.md before connecting a provider.</p></div></div><div className="panel danger-zone"><h3>Local data</h3><p>Project data is currently stored in this browser&apos;s local storage. Export regular backups. Uploaded reference images are stored as browser data URLs and may use significant storage.</p><button className="button secondary" onClick={exportProject}>Export project backup</button><button className="text-button danger" onClick={()=>{if(confirm("Reset this browser's Wonderboy project? Export a backup first.")){localStorage.removeItem(STORAGE_KEY);setProject(starter);setNotice("Project reset.");}}}>Reset local project</button></div></div>}
        <footer className="footer"><span>WONDERBOY AI STUDIO · PRIVATE CREATIVE WORKSPACE</span><span>{notice}</span></footer>
      </section>
    </main>
  );
}

function ReferenceGroup({title,items,onDelete}:{title:string;items:RefAsset[];onDelete:(id:string)=>void}) {
  return <div className="panel ref-group"><div className="panel-head"><h3>{title}</h3><span className="muted">{items.length} SAVED</span></div>{items.length===0?<div className="empty-state">No references yet. Add one using the form.</div>:<div className="ref-grid">{items.map(a=><div className="ref-card" key={a.id}>{a.image?<img src={a.image} alt={a.name}/>:<div className="ref-placeholder">{a.kind==="character"?"◉":"⌂"}</div>}<div className="ref-card-body"><b>{a.name}</b><p>{a.description}</p><button className="tiny-button" onClick={()=>onDelete(a.id)}>Remove</button></div></div>)}</div>}</div>;
}
