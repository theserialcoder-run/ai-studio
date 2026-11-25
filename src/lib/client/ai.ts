// Browser-side helpers for the AI routes.
import { fileUrl } from "../projectModel";
import type { Proposal } from "../proposals";
import type { StoryDraft, StoryJob, StoryJobView } from "../storyCut";
import type { Asset, ID } from "../types";
import type { ComfyStatus, Conversation, GenerationRecord, GenerationRequest, ProvidersResponse, ReferenceInput } from "../ai/types";

export type GenerationView = GenerationRecord & { progress: string | null };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new Error("Could not reach the Wonderboy server. Is it running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}
const post = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const aiApi = {
  providers: () => call<ProvidersResponse>("/api/providers"),
  storyJobs: (pid: ID) => call<{ jobs: StoryJobView[]; tools: { ok: boolean; error?: string } }>(`/api/projects/${pid}/storycuts/jobs`),
  startStoryJob: (pid: ID, body: { kind: StoryJob["kind"]; cutId: ID; overwrite?: boolean; sensitivity?: number; rescan?: boolean }) =>
    call<{ job: StoryJob }>(`/api/projects/${pid}/storycuts/jobs`, post(body)).then(d => d.job),
  writeStory: (pid: ID, body: { cutId: ID; style: string; instructions: string }) =>
    call<StoryDraft & { provider: string }>(`/api/projects/${pid}/storycuts/story`, post(body)),
  suggestCast: (pid: ID, cutId: ID) =>
    call<{ cast: { name: string; look: string }[]; provider: string }>(`/api/projects/${pid}/storycuts/script`, post({ cutId, action: "cast" })),
  matchScript: (pid: ID, cutId: ID) =>
    call<{ lines: { id: ID; text: string; sceneId: ID | null; options: ID[] }[]; notes: string; provider: string }>(`/api/projects/${pid}/storycuts/script`, post({ cutId, action: "match" })),
  comfyStatus: (check: boolean) => call<ComfyStatus>(`/api/comfyui${check ? "?check=1" : ""}`),
  saveComfy: (body: { url: string; authHeader?: string; clearAuth?: boolean }) => call<ComfyStatus>("/api/comfyui", post(body, "PUT")),
  generations: (pid: ID) => call<{ generations: GenerationView[] }>(`/api/projects/${pid}/generations`).then(d => d.generations),
  generate: (pid: ID, req: GenerationRequest & { label: string }) => call<{ generation: GenerationRecord }>(`/api/projects/${pid}/generations`, post(req)).then(d => d.generation),
  conversations: (pid: ID) => call<{ conversations: Conversation[] }>(`/api/projects/${pid}/conversations`).then(d => d.conversations),
  createConversation: (pid: ID) => call<{ conversation: Conversation }>(`/api/projects/${pid}/conversations`, post({})).then(d => d.conversation),
  renameConversation: (pid: ID, cid: ID, title: string) => call(`/api/projects/${pid}/conversations/${cid}`, post({ title }, "PATCH")),
  deleteConversation: (pid: ID, cid: ID) => call(`/api/projects/${pid}/conversations/${cid}`, { method: "DELETE" }),
  send: (pid: ID, cid: ID, message: string, focus: { scriptId?: ID | null; sceneId?: ID | null }) =>
    call<{ conversation: Conversation; provider: string }>(`/api/projects/${pid}/conversations/${cid}/messages`, post({ message, focus })),
  assist: (pid: ID, task: string, instructions: string, focus: { scriptId?: ID | null; sceneId?: ID | null }) =>
    call<{ summary: string; proposals: Proposal[]; provider: string }>(`/api/projects/${pid}/assist`, post({ task, instructions, focus })),
};

/**
 * Load a project image and re-encode it as JPEG with its longest side <= maxSide
 * (Cloudflare FLUX.2 requires references smaller than 512×512).
 */
export async function prepareImage(projectId: ID, asset: Asset, maxSide: number, role: ReferenceInput["role"], label: string): Promise<ReferenceInput> {
  if (asset.kind !== "image") throw new Error(`“${asset.name}” is not an image.`);
  const img = new Image();
  img.decoding = "async";
  img.src = fileUrl(projectId, asset.id);
  try {
    await img.decode();
  } catch {
    throw new Error(`Could not load image “${asset.name}”.`);
  }
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.floor(img.naturalWidth * scale));
  const h = Math.max(1, Math.floor(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  return { assetId: asset.id, role, label, mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}
