"use client";
import { timeAgo } from "@/lib/projectModel";
import { SHOT_STATUSES } from "@/lib/types";
import { useStudio, type Tab } from "./studio";

function pct(n: number, d: number) {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

function Progress({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="progress-row">
      <div className="progress-label"><span>{label}</span><b>{value}%</b></div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${value}%` }} /></div>
      <small className="muted">{detail}</small>
    </div>
  );
}

export function DashboardView() {
  const { project: p, go } = useStudio();
  const shots = p.shots;
  const done = shots.filter(s => s.status === "Done").length;
  const specced = shots.filter(s => s.description.trim() && s.framing.trim() && s.cameraAngle.trim()).length;
  const linked = shots.filter(s => s.locationId && s.characters.length > 0).length;
  const refChars = p.characters.filter(c => c.referenceAssetIds.length > 0).length;
  const refLocs = p.locations.filter(l => l.referenceAssetIds.length > 0).length;
  const scriptWords = p.scripts.reduce((n, s) => n + s.content.trim().split(/\s+/).filter(Boolean).length, 0);
  const runtime = shots.reduce((n, s) => n + (s.durationSec ?? 0), 0);
  const stat = (n: number) => String(n).padStart(2, "0");

  const workflow: [string, string, string, Tab][] = [
    ["01", "Develop the story", "Talk through the idea with your AI companion", "AI Companion"],
    ["02", "Write the script", "Write the screenplay and break it into scenes", "Script"],
    ["03", "Build your cast and world", "Characters and locations with reference images", "Characters"],
    ["04", "Plan your shots", "Camera, framing, lighting and continuity per shot", "Shots"],
  ];

  return (
    <div className="content">
      <section className="hero">
        <div>
          <span className="eyebrow gold">YOUR NEXT FILM STARTS HERE</span>
          <h2>Make something<br /><em>worth watching.</em></h2>
          <p>Develop the story. Build the world. Create every shot. Keep your visual continuity in one place.</p>
          <button className="button primary" onClick={() => go("AI Companion")}>Start creating <span>↗</span></button>
        </div>
        <div className="hero-art"><div className="film-frame"><div className="sun" /><div className="hill hill-one" /><div className="hill hill-two" /><div className="frame-caption">A STORY BY YOU</div></div></div>
      </section>

      <div className="section-head">
        <div><span className="eyebrow">CURRENT PROJECT</span><h3>{p.name}</h3><p>{p.logline || "Add a logline to describe your film."}</p></div>
        <button className="text-button" onClick={() => go("Settings")}>Edit project ↗</button>
      </div>

      <div className="stats-grid six">
        <button className="stat-card" onClick={() => go("Script")}><span>SCENES</span><b>{stat(p.scenes.length)}</b><small>{p.scripts.length} script{p.scripts.length === 1 ? "" : "s"} · {scriptWords} words</small></button>
        <button className="stat-card" onClick={() => go("Shots")}><span>SHOTS</span><b>{stat(shots.length)}</b><small>{runtime ? `~${Math.round(runtime)}s planned runtime` : "No durations yet"}</small></button>
        <button className="stat-card" onClick={() => go("Characters")}><span>CHARACTERS</span><b>{stat(p.characters.length)}</b><small>{refChars} with reference images</small></button>
        <button className="stat-card" onClick={() => go("Locations")}><span>LOCATIONS</span><b>{stat(p.locations.length)}</b><small>{refLocs} with reference images</small></button>
        <button className="stat-card" onClick={() => go("Assets")}><span>ASSETS</span><b>{stat(p.assets.length)}</b><small>Uploaded files</small></button>
        <button className="stat-card" onClick={() => go("Shots")}><span>COMPLETED</span><b>{stat(done)}</b><small>Shots marked done</small></button>
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-head"><h3>Production progress</h3><span className="muted">CALCULATED FROM YOUR DATA</span></div>
          <Progress label="Shots completed" value={pct(done, shots.length)} detail={`${done} of ${shots.length} shots marked Done`} />
          <Progress label="Shots fully specified" value={pct(specced, shots.length)} detail="Description, framing and camera angle filled in" />
          <Progress label="Shots with continuity links" value={pct(linked, shots.length)} detail="Location and at least one character selected" />
          <Progress label="Characters with references" value={pct(refChars, p.characters.length)} detail={`${refChars} of ${p.characters.length} have reference images`} />
          <Progress label="Locations with references" value={pct(refLocs, p.locations.length)} detail={`${refLocs} of ${p.locations.length} have reference images`} />
          <div className="status-breakdown">
            {SHOT_STATUSES.map(s => <span key={s}>{s}: <b>{shots.filter(x => x.status === s).length}</b></span>)}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h3>Recent activity</h3><span className="muted">{p.activity.length} EVENTS</span></div>
          {p.activity.length === 0
            ? <p className="muted small">Nothing yet.</p>
            : <ul className="activity-list">{p.activity.slice(0, 12).map(a => <li key={a.id}><span>{a.message}</span><time dateTime={a.at}>{timeAgo(a.at)}</time></li>)}</ul>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Creative workflow</h3><span className="muted">YOUR PROCESS</span></div>
        {workflow.map(x => <button className="workflow-row" key={x[0]} onClick={() => go(x[3])}><b>{x[0]}</b><span><strong>{x[1]}</strong><small>{x[2]}</small></span><i>↗</i></button>)}
      </div>
    </div>
  );
}
