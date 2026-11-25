// HTTP helpers for provider calls. Server-only.
import https from "node:https";

export class ProviderError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

/** Turn an HTTP failure into a message the user can act on. */
export function explainHttpError(provider: string, status: number, detail: string): ProviderError {
  const d = detail ? ` Provider said: ${detail.slice(0, 400)}` : "";
  if (status === 400) return new ProviderError(`${provider} rejected the request (400).${d}`, 400);
  if (status === 401 || status === 403) return new ProviderError(`${provider} refused the credentials (${status}). Check the API key/token and its permissions in .env.local.${d}`, 401);
  if (status === 402) return new ProviderError(`${provider} requires billing or more credits (402). No charge was made by Wonderboy.${d}`, 402);
  if (status === 404) return new ProviderError(`${provider} could not find the model, endpoint or account (404). Check the account ID and model ID in .env.local — the model may also have been renamed or retired.${d}`, 404);
  if (status === 429) return new ProviderError(`${provider} rate limit or free allocation exhausted (429). Wait and retry later, or check your quota.${d}`, 429);
  if (status >= 500) return new ProviderError(`${provider} had a server error (${status}). Retry in a moment.${d}`, 502);
  return new ProviderError(`${provider} request failed (${status}).${d}`, 502);
}

/** Pull a readable error message out of a JSON or text error body. */
export function errorDetail(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message || j?.errors?.[0]?.message || j?.detail?.[0]?.msg || j?.detail || j?.message || j?.error || body;
  } catch {
    return body;
  }
}

/**
 * POST JSON with a long timeout using node:https (undici's fetch has a fixed
 * 5-minute header timeout, too short for video generation).
 */
export function postJsonLong(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 15 * 60_000): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(payload.length), ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new ProviderError("The provider did not respond in time.", 504)));
    req.on("error", e => reject(e instanceof ProviderError ? e : new ProviderError(`Could not reach the provider: ${e.message}`, 502)));
    req.end(payload);
  });
}

export async function fetchOrThrow(provider: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ProviderError(`Could not reach ${provider}: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  if (!res.ok) throw explainHttpError(provider, res.status, errorDetail(await res.text().catch(() => "")));
  return res;
}

export async function download(provider: string, url: string, headers: Record<string, string> = {}): Promise<{ data: Buffer; mimeType: string }> {
  const res = await fetchOrThrow(provider, url, { headers, redirect: "follow" });
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
}

export function sniffImageMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return "image/png";
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function env(name: string): string {
  return (process.env[name] ?? "").trim();
}
