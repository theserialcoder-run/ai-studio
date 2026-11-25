// Text model providers for the AI companion and script assistant. Server-only.
import type { LlmProviderInfo } from "../../ai/types";
import { env, errorDetail, explainHttpError, fetchOrThrow, ProviderError } from "./http";

export interface LlmMessage { role: "user" | "assistant"; content: string }
export interface LlmRequest { system: string; messages: LlmMessage[]; json?: boolean; maxTokens?: number }

interface LlmProvider { info(): LlmProviderInfo; chat(req: LlmRequest): Promise<string> }

/* ---------------------------------------------------------------- Gemini */
// generateContent is documented by Google as still fully supported (the newer
// Interactions API is recommended for new features). Key goes in a header.
const gemini: LlmProvider = {
  info: () => ({
    kind: "llm", id: "gemini", label: "Google Gemini", vendor: "Google AI Studio",
    model: env("GEMINI_TEXT_MODEL") || "gemini-3.8-flash",
    configured: !!env("GEMINI_API_KEY"), billing: "free-allocation",
    costNote: "Free tier with rate limits on current Flash models; paid tier if you enable billing in AI Studio.",
    requirements: ["GEMINI_API_KEY"],
    setup: "Create a key at aistudio.google.com → Get API key. Optional: GEMINI_TEXT_MODEL.",
    conditioning: "Text model.",
  }),
  async chat({ system, messages, json, maxTokens }) {
    const key = env("GEMINI_API_KEY");
    if (!key) throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to .env.local and restart.", 400);
    const model = gemini.info().model;
    const res = await fetchOrThrow("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens ?? 8192, ...(json ? { responseMimeType: "application/json" } : {}) },
      }),
    });
    const data = await res.json();
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
    if (!text) {
      const reason = cand?.finishReason || data?.promptFeedback?.blockReason;
      throw new ProviderError(`Gemini returned no text${reason ? ` (reason: ${reason})` : ""}.`, 502);
    }
    return text;
  },
};

/* -------------------------------------------------- OpenAI-compatible APIs */
// Works with Hugging Face router (https://router.huggingface.co/v1), Groq,
// OpenRouter, Cloudflare (https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1) …
const openaiCompatible: LlmProvider = {
  info: () => ({
    kind: "llm", id: "openai-compatible", label: "OpenAI-compatible endpoint", vendor: env("LLM_BASE_URL").replace(/^https?:\/\//, "").split("/")[0] || "not set",
    model: env("LLM_MODEL") || "(set LLM_MODEL)",
    configured: !!(env("LLM_BASE_URL") && env("LLM_API_KEY") && env("LLM_MODEL")), billing: "paid",
    costNote: "Depends on the service. Hugging Face Inference Providers bills per provider rate (free accounts no longer get monthly credits); Groq/OpenRouter offer limited free models.",
    requirements: ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"],
    setup: "Set LLM_BASE_URL (…/v1), LLM_API_KEY and LLM_MODEL. Use LLM_PROVIDER=openai-compatible to prefer it over Gemini.",
    conditioning: "Text model.",
  }),
  async chat({ system, messages, json, maxTokens }) {
    const i = openaiCompatible.info();
    if (!i.configured) throw new ProviderError("OpenAI-compatible endpoint is not configured (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL).", 400);
    const res = await fetch(`${env("LLM_BASE_URL").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("LLM_API_KEY")}` },
      body: JSON.stringify({
        model: i.model,
        max_tokens: maxTokens ?? 8192,
        messages: [{ role: "system", content: system + (json ? "\nRespond with a single JSON object only." : "") }, ...messages],
      }),
    }).catch(e => { throw new ProviderError(`Could not reach ${i.vendor}: ${e.message}`, 502); });
    if (!res.ok) throw explainHttpError(i.vendor, res.status, errorDetail(await res.text()));
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError(`${i.vendor} returned no text.`, 502);
    return String(text);
  },
};

const PROVIDERS = [gemini, openaiCompatible];

export function llmProviders(): LlmProviderInfo[] {
  return PROVIDERS.map(p => p.info());
}

export function activeLlm(): LlmProvider | null {
  const preferred = env("LLM_PROVIDER");
  const configured = PROVIDERS.filter(p => p.info().configured);
  return configured.find(p => p.info().id === preferred) ?? configured[0] ?? null;
}

export async function chat(req: LlmRequest): Promise<{ text: string; provider: string }> {
  const p = activeLlm();
  if (!p) throw new ProviderError("No text AI provider is configured. Add GEMINI_API_KEY (free tier) to .env.local and restart — see docs/PROVIDERS.md.", 400);
  return { text: await p.chat(req), provider: `${p.info().label} · ${p.info().model}` };
}
