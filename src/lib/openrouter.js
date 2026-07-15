const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_LLM = process.env.LIFECOMIC_LLM_MODEL || "google/gemini-2.5-flash";
const DEFAULT_IMAGE = process.env.LIFECOMIC_IMAGE_MODEL || "google/gemini-3.1-flash-lite-image";

const HEADERS = () => ({
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  "Content-Type": "application/json",
  "HTTP-Referer": process.env.BASE_URL || "https://lifecomic.local",
  "X-Title": "LifeComic",
});

export function isConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

async function post(body, { timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: HEADERS(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion that returns parsed JSON. Instructs the model to emit strict JSON and strips any
 * ```json fences before parsing. Throws on unparsable output so callers can fall back.
 */
export async function chatJSON(prompt, { model = DEFAULT_LLM, system, timeoutMs = 60_000 } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const json = await post({ model, messages, response_format: { type: "json_object" } }, { timeoutMs });
  const text = json.choices?.[0]?.message?.content ?? "";
  const cost = json.usage?.cost ?? null;
  const parsed = parseJsonLoose(text);
  return { data: parsed, cost, raw: text };
}

function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: grab the outermost {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("model did not return valid JSON");
  }
}

/**
 * Generates one image and returns { buffer, mime, cost }. Uses the chat-completions image modality
 * (confirmed shape: choices[0].message.images[0].image_url.url = data:<mime>;base64,<data>).
 */
export async function generateImage(prompt, { model = DEFAULT_IMAGE, timeoutMs = 90_000 } = {}) {
  const json = await post(
    { model, messages: [{ role: "user", content: prompt }], modalities: ["image", "text"] },
    { timeoutMs },
  );
  const image = json.choices?.[0]?.message?.images?.[0];
  const url = image?.image_url?.url ?? image?.url ?? "";
  const match = String(url).match(/^data:(image\/\w+);base64,(.+)$/s);
  if (!match) throw new Error("no image returned by model");
  return {
    buffer: Buffer.from(match[2], "base64"),
    mime: match[1],
    cost: json.usage?.cost ?? null,
  };
}

export const models = { llm: DEFAULT_LLM, image: DEFAULT_IMAGE };
