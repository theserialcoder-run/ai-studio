// AI companion + script assistant: project context, prompts, conversations. Server-only.
import { randomUUID } from "node:crypto";
import type { Conversation, StoredMessage } from "../ai/types";
import { nowIso, sceneNumber, scenesOf, shotNumber, shotsOf } from "../projectModel";
import { normalizeProposals, parseJsonLoose, PROPOSAL_FORMAT, type Proposal } from "../proposals";
import type { ID, Project } from "../types";
import { chat } from "./ai/llm";
import { readProject, readSideFile, StorageError, updateSideFile } from "./storage";

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 200;
const HISTORY_FOR_MODEL = 24;

export interface Focus { scriptId?: ID | null; sceneId?: ID | null }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);

/** Compact, ID-annotated description of the project for the model. */
export function projectContext(p: Project, focus: Focus = {}): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${p.name}`, `Logline: ${p.logline || "(none)"}`, `Style bible: ${clip(p.style, 600)}`);
  lines.push("", "CHARACTERS:");
  for (const c of p.characters) lines.push(`- ${c.name}: ${clip([c.description, c.appearance && `Appearance: ${c.appearance}`, c.clothing && `Clothing: ${c.clothing}`, c.personality && `Personality: ${c.personality}`].filter(Boolean).join(" | "), 500)}${c.variations.length ? ` | Variations: ${c.variations.map(v => v.name).join(", ")}` : ""}`);
  if (!p.characters.length) lines.push("(none yet)");
  lines.push("", "LOCATIONS:");
  for (const l of p.locations) lines.push(`- ${l.name}: ${clip([l.description, l.architecture, l.layout, l.visualDetails && `Fixed details: ${l.visualDetails}`].filter(Boolean).join(" | "), 400)}`);
  if (!p.locations.length) lines.push("(none yet)");

  const focusScene = p.scenes.find(s => s.id === focus.sceneId);
  const focusScriptId = focus.scriptId ?? focusScene?.scriptId ?? p.scripts[0]?.id;
  lines.push("", "SCRIPTS AND SCENES:");
  for (const script of p.scripts) {
    const isFocus = script.id === focusScriptId;
    lines.push(`Script "${script.title}" [scriptId: ${script.id}]${isFocus ? " (currently open)" : ""}, ${script.content.length} characters`);
    if (isFocus && script.content.trim()) lines.push("Screenplay text:", clip(script.content, 14000));
    for (const scene of scenesOf(p, script.id)) {
      const shots = shotsOf(p, scene.id);
      const loc = p.locations.find(l => l.id === scene.locationId)?.name;
      const chars = scene.characterIds.map(id => p.characters.find(c => c.id === id)?.name).filter(Boolean).join(", ");
      lines.push(`  Scene ${sceneNumber(p, scene.id)} [sceneId: ${scene.id}] ${scene.heading || scene.title}${loc ? ` @ ${loc}` : ""}${chars ? ` with ${chars}` : ""}: ${clip(scene.description, 300)} (${shots.length} shots)`);
      if (scene.id === focus.sceneId) {
        if (scene.dialogue) lines.push("  Scene dialogue/action:", clip(scene.dialogue, 6000));
        for (const sh of shots) lines.push(`    Shot ${shotNumber(p, sh)}: ${sh.title} — ${clip(sh.description, 200)} [${[sh.framing, sh.cameraAngle, sh.cameraMovement].filter(Boolean).join(", ")}]`);
      }
    }
  }
  if (focusScene) lines.push("", `FOCUSED SCENE: sceneId ${focusScene.id} (${focusScene.heading || focusScene.title})`);
  return clip(lines.join("\n"), 40000);
}

const COMPANION_SYSTEM = `You are the creative companion inside Wonderboy AI Studio, a personal AI filmmaking workspace.
Help with brainstorming, storytelling, scriptwriting, dialogue, scene development, characters, locations and shot planning.
Be practical, specific and collaborative. Respect established continuity: do not change a character's or location's canonical details unless asked.
Use standard screenplay format for script text.

When the user asks you to create or change project content (scripts, scenes, shots, characters, locations, logline), answer normally AND append exactly one fenced block:
\`\`\`wonderboy
{"proposals":[ ...proposal objects... ]}
\`\`\`
The user reviews proposals before anything is applied, so never claim a change has been made. Never set replaceScriptId unless the user explicitly asked to rewrite/replace that existing script.
Only include the block when there is something concrete to apply.

${PROPOSAL_FORMAT}`;

/* ----------------------------------------------------------- conversations */

type Store = Conversation[];

export async function listConversations(projectId: string): Promise<Conversation[]> {
  return readSideFile<Store>(projectId, "conversations", []);
}

export async function createConversation(projectId: string, title?: string): Promise<Conversation> {
  const t = nowIso();
  const conv: Conversation = { id: randomUUID(), title: title?.trim().slice(0, 120) || "New conversation", messages: [], createdAt: t, updatedAt: t };
  await updateSideFile<Store>(projectId, "conversations", [], cur => [conv, ...cur].slice(0, MAX_CONVERSATIONS));
  return conv;
}

export async function renameConversation(projectId: string, id: string, title: string) {
  await updateSideFile<Store>(projectId, "conversations", [], cur => cur.map(c => (c.id === id ? { ...c, title: title.trim().slice(0, 120) || c.title } : c)));
}

export async function deleteConversation(projectId: string, id: string) {
  await updateSideFile<Store>(projectId, "conversations", [], cur => cur.filter(c => c.id !== id));
}

/** Sends a message with history + live project context; persists both turns only on success. */
export async function sendMessage(projectId: string, conversationId: string, message: string, focus: Focus, signal?: AbortSignal): Promise<{ conversation: Conversation; provider: string }> {
  const text = message.trim();
  if (!text) throw new StorageError("Message is empty.", 400);
  const [project, conversations] = await Promise.all([readProject(projectId), listConversations(projectId)]);
  const conv = conversations.find(c => c.id === conversationId);
  if (!conv) throw new StorageError("Conversation not found.", 404);

  const history = conv.messages.slice(-HISTORY_FOR_MODEL).map(m => ({ role: m.role, content: m.content }));
  const { text: reply, provider } = await chat({
    system: `${COMPANION_SYSTEM}\n\nCURRENT PROJECT CONTEXT (live data):\n${projectContext(project, focus)}`,
    messages: [...history, { role: "user", content: text }],
    signal,
  });
  if (signal?.aborted) throw new StorageError("Cancelled.", 499); // the user cancelled: keep nothing

  const t = nowIso();
  const userMsg: StoredMessage = { id: randomUUID(), role: "user", content: text, createdAt: t };
  const aiMsg: StoredMessage = { id: randomUUID(), role: "assistant", content: reply, createdAt: nowIso() };
  let updated: Conversation | undefined;
  await updateSideFile<Store>(projectId, "conversations", [], cur => cur.map(c => {
    if (c.id !== conversationId) return c;
    updated = {
      ...c,
      title: c.messages.length === 0 && c.title === "New conversation" ? text.slice(0, 60) : c.title,
      messages: [...c.messages, userMsg, aiMsg].slice(-MAX_MESSAGES),
      updatedAt: nowIso(),
    };
    return updated;
  }));
  if (!updated) throw new StorageError("Conversation was deleted.", 404);
  return { conversation: updated, provider };
}

/* --------------------------------------------------------- script assistant */

export const ASSIST_TASKS = {
  ideas: "Generate 5 distinct story ideas suited to this project (title + 2-3 sentence pitch each). Return one text proposal.",
  logline: "Write 3-5 strong logline options for this project. Return one logline proposal.",
  outline: "Write a plot outline (beginning, middle, end, key turning points, sequence of scenes). Return one text proposal.",
  script: "Write a complete short screenplay in standard format, consistent with the project's characters, locations and style. Return one script proposal with replaceScriptId null.",
  improve_script: "Improve the currently open script (structure, pacing, dialogue) while keeping its story. Return one script proposal with replaceScriptId set to the open script's scriptId.",
  breakdown: "Break the currently open script into scenes (heading, title, description, dialogue/action, characters, location). Return one scenes proposal with scriptId set to the open script. Use existing character/location names where they match.",
  rewrite_dialogue: "Rewrite the dialogue of the focused scene to be more natural and characterful, keeping the story beats. Return one scene_update proposal (patch.dialogue) for the focused sceneId.",
  improve_scene: "Improve the focused scene: sharpen its description, action and dialogue. Return one scene_update proposal for the focused sceneId.",
  shot_list: "Create a cinematic shot list for the focused scene (6-12 shots) with framing, camera angle, movement, lighting, mood, duration and the characters/location in each shot. Return one shots proposal with sceneId set to the focused sceneId.",
  characters: "Suggest the main characters this story needs that are not already in the library, with detailed visual appearance and clothing for consistent image generation. Return one characters proposal.",
  locations: "Suggest the key locations this story needs that are not already in the library, with architecture, layout, lighting and fixed visual details. Return one locations proposal.",
} as const;
export type AssistTask = keyof typeof ASSIST_TASKS;

export async function runAssist(projectId: string, task: string, instructions: string, focus: Focus): Promise<{ summary: string; proposals: Proposal[]; provider: string }> {
  if (!(task in ASSIST_TASKS)) throw new StorageError("Unknown assistant task.", 400);
  const project = await readProject(projectId);
  const needsScene = ["rewrite_dialogue", "improve_scene", "shot_list"].includes(task);
  if (needsScene && !project.scenes.some(s => s.id === focus.sceneId)) throw new StorageError("Select a scene first.", 400);

  const system = `You are the script assistant inside Wonderboy AI Studio. You produce suggestions the user reviews before applying.
Respond with a single JSON object: {"summary": string, "proposals": [ ... ]}.
${PROPOSAL_FORMAT}

PROJECT CONTEXT:
${projectContext(project, focus)}`;
  const { text, provider } = await chat({
    system,
    messages: [{ role: "user", content: `${ASSIST_TASKS[task as AssistTask]}${instructions.trim() ? `\n\nAdditional instructions from the user: ${instructions.trim().slice(0, 4000)}` : ""}` }],
    json: true,
  });
  const parsed = parseJsonLoose(text) as { summary?: unknown } | null;
  const proposals = normalizeProposals(parsed, project);
  if (!proposals.length) throw new StorageError("The AI response could not be turned into a usable suggestion. Try again or rephrase the instructions.", 502);
  return { summary: typeof parsed?.summary === "string" ? parsed.summary : "", proposals, provider };
}
