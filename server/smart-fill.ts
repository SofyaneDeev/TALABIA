// Talabia AI Smart fill: Claude Haiku first (secret ANTHROPIC_API_KEY), Google Gemini as backup (secret GEMINI_API_KEY).
// Reads a customer's message — pasted text, a screenshot or a WhatsApp voice note — and returns the order fields.
// Needs the secret ANTHROPIC_API_KEY and/or GEMINI_API_KEY (Supabase → Edge Functions → Secrets). Optional CLAUDE_MODEL.
// Optional secret GEMINI_MODEL to force a model; otherwise the models below are tried in order.
import { createClient } from "jsr:@supabase/supabase-js@2";

const FREE_AI_PER_MONTH = 20;
// Fastest first: Flash-Lite reads text, pictures and voice notes with very little "thinking".
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-lite-latest", "gemini-flash-latest"]
  .filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
const MODEL_TIMEOUT_MS = 20000; // give up on a model after 20 s and try the next one
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB
const MEDIA_TYPES: Record<string, string> = {
  "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp",
  "image/heic": "image/heic", "image/heif": "image/heif",
  "audio/ogg": "audio/ogg", "audio/opus": "audio/ogg", "application/ogg": "audio/ogg",
  "audio/mpeg": "audio/mp3", "audio/mp3": "audio/mp3", "audio/wav": "audio/wav", "audio/x-wav": "audio/wav",
  "audio/aac": "audio/aac", "audio/mp4": "audio/aac", "audio/x-m4a": "audio/aac", "audio/m4a": "audio/aac",
  "audio/flac": "audio/flac", "audio/webm": "audio/webm",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function buildPrompt(message: string, catalog: unknown, kind: "text" | "image" | "audio") {
  const where = kind === "image"
    ? "The order is in the attached picture (usually a screenshot of an Instagram or WhatsApp chat). Read only the customer's messages, not the seller's replies."
    : kind === "audio"
    ? "The order is in the attached voice note. Listen carefully: it is usually in Moroccan Darija, sometimes mixed with French or Arabic."
    : "The order is in the message below.";
  return `You read a customer's order sent to a small online shop in Morocco and extract the order.
${where}
The customer can mix Moroccan Darija (in Latin letters with numbers like 3, 7, 9 — or in Arabic script), French, Arabic and English, with typos and in any order.
The shop's products (JSON): ${JSON.stringify(catalog)}
Reply with ONLY one JSON object and nothing else:
{"name": the customer's name (first and family name if given; never a product, city or street) or null,
 "phone": Moroccan number as 10 digits starting with 05, 06 or 07 (convert +212 or 00212 to 0) or null,
 "city": Moroccan city in its usual French spelling (e.g. Casablanca, Fès, Tétouan, Marrakech) or null,
 "address": delivery address without the city and name: neighborhood (hay/quartier), street (zanqa/rue/bd), building, apartment, lot, number, landmark — or null,
 "items": EVERY catalog product the customer wants, as a list of {"productId": the catalog id, "qty": how many (Darija: wa7d=1, joj/jouj/zouj=2, tlata=3, rb3a=4; default 1)} — one entry per different product, [] if none matches,
 "productAsked": what the customer asked for in their own words when a product is not in the catalog, else null,
 "note": short useful details for the seller such as size, color, delivery time or a question the customer asked, else null,
 "heard": ${kind === "text" ? "null" : "the customer's words as you read or heard them, written in Latin letters the way Moroccans text (max 400 characters)"}}
Do not invent anything: use null when something is not in the order.${message.trim() ? `
Message:
"""${message}"""` : ""}`;
}

// Claude (Anthropic). Fast model, no extended thinking, short answer. Reads text and pictures (not voice notes).
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-haiku-5-5";
const CLAUDE_IMAGES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
async function askClaude(prompt: string, media: { mime: string; data: string } | null) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { error: "no_key" };
  if (media && !CLAUDE_IMAGES.includes(media.mime)) return { error: "media_type" };
  const content: unknown[] = [];
  if (media) content.push({ type: "image", source: { type: "base64", media_type: media.mime, data: media.data } });
  content.push({ type: "text", text: prompt });
  const t0 = Date.now();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 800, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(15000),
    });
    console.log(`smart-fill: ${CLAUDE_MODEL} -> ${r.status} in ${Date.now() - t0} ms`);
    if (!r.ok) { console.error("Claude error", r.status, (await r.text()).slice(0, 300)); return { error: "ai_failed", status: r.status }; }
    const out = await r.json();
    const text = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    return { text };
  } catch (_e) {
    console.log(`smart-fill: ${CLAUDE_MODEL} timed out after ${Date.now() - t0} ms`);
    return { error: "ai_failed", status: 504 };
  }
}

async function askGemini(prompt: string, media: { mime: string; data: string } | null) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return { error: "no_key" };
  const parts: unknown[] = [{ text: prompt }];
  if (media) parts.push({ inline_data: { mime_type: media.mime, data: media.data } });
  let last = 0;
  const started = Date.now();
  for (const model of MODELS) {
    if (Date.now() - started > 40000 - MODEL_TIMEOUT_MS) { console.log("smart-fill: out of time, giving up"); break; }
    // First ask for minimal "thinking" (much faster); if this model doesn't accept that option, ask again without it.
    for (const minimal of [true, false]) {
      const generationConfig: Record<string, unknown> = { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: "application/json" };
      if (minimal) generationConfig.thinkingConfig = { thinkingLevel: model.includes("lite") ? "minimal" : "low" };
      const t0 = Date.now();
      let r: Response;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
          signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
        });
      } catch (_e) {
        console.log(`smart-fill: ${model} timed out after ${Date.now() - t0} ms`);
        last = 504;
        break; // too slow: next model
      }
      last = r.status;
      console.log(`smart-fill: ${model}${minimal ? " (minimal thinking)" : ""} -> ${r.status} in ${Date.now() - t0} ms`);
      if (r.status === 400 && minimal) { await r.text(); continue; } // option not supported: retry without it
      if ([400, 404, 429, 500, 503].includes(r.status)) { await r.text(); break; } // missing, busy or out of free quota: next model
      if (!r.ok) { console.error("Gemini error", model, r.status, (await r.text()).slice(0, 300)); return { error: "ai_failed", status: r.status }; }
      const out = await r.json();
      const text = (out.candidates?.[0]?.content?.parts || [])
        .filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text || "").join("");
      console.log(`smart-fill: answered by ${model}, total ${Date.now() - started} ms`);
      return { text };
    }
  }
  return { error: "ai_failed", status: last };
}

// The server's secret key: older projects have SUPABASE_SERVICE_ROLE_KEY, newer ones SUPABASE_SECRET_KEYS.
function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const first = keys.default || Object.values(keys)[0];
    if (typeof first === "string" && first) return first;
  } catch { /* ignore */ }
  return Deno.env.get("SUPABASE_SECRET_KEY") || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serverKey());

    // Who is asking?
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) { console.error("smart-fill sign-in check failed:", error?.message); return reply({ error: "not_signed_in" }, 401); }

    // Plan and monthly AI allowance
    const { data: p } = await admin.from("profiles").select("*").eq("id", user.id).single();
    if (!p) return reply({ error: "no_profile" }, 404);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const used = p.ai_month === month ? p.ai_used : 0;
    const pro = p.plan === "pro" && (!p.pro_until || p.pro_until >= today);
    if (!pro && used >= FREE_AI_PER_MONTH) return reply({ error: "limit", used, limit: FREE_AI_PER_MONTH }, 402);

    // The message (text and/or a photo or voice note) and the seller's products
    const body = await req.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message.slice(0, 2500) : "";
    const catalog = Array.isArray(body.catalog) ? body.catalog.slice(0, 300) : [];
    let media: { mime: string; data: string } | null = null;
    if (body.media && typeof body.media.data === "string" && typeof body.media.mime === "string") {
      const mime = MEDIA_TYPES[body.media.mime.toLowerCase().split(";")[0].trim()];
      if (!mime) return reply({ error: "media_type" }, 400);
      if (body.media.data.length * 0.75 > MAX_MEDIA_BYTES) return reply({ error: "media_too_big" }, 413);
      media = { mime, data: body.media.data };
    }
    if (!message.trim() && !media) return reply({ error: "empty" }, 400);
    const kind = media ? (media.mime.startsWith("image/") ? "image" : "audio") : "text";

    const prompt = buildPrompt(message, catalog, kind);
    let ai: { text?: string; error?: string; status?: number } = await askClaude(prompt, media);
    if ("error" in ai) {
      const g = await askGemini(prompt, media);
      // keep the Claude answer's reason if Gemini isn't set up either
      ai = "error" in g && g.error === "no_key" && ai.error !== "no_key" ? ai : g;
    }
    if ("error" in ai) return reply(ai, ai.error === "no_key" ? 500 : 502);
    let result = null;
    const answer = ai.text || "";
    try { result = JSON.parse(answer); } catch { const m = answer.match(/\{[\s\S]*\}/); if (m) { try { result = JSON.parse(m[0]); } catch { /* ignore */ } } }
    if (!result) return reply({ error: "unreadable" }, 502);
    // Older app versions read one product: keep productId/qty filled from the first item
    if (Array.isArray(result.items) && result.items.length && !result.productId) { result.productId = result.items[0].productId; result.qty = result.items[0].qty; }

    // Count this read
    await admin.from("profiles").update({ ai_month: month, ai_used: used + 1 }).eq("id", user.id);
    return reply({ result, pro, used: used + 1, limit: pro ? null : FREE_AI_PER_MONTH });
  } catch (e) {
    console.error("smart-fill failed:", e);
    return reply({ error: "server_error" }, 500);
  }
});
