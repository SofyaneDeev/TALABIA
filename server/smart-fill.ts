// Talabia AI Smart fill. Reads a customer's message and returns the order fields.
// Needs the secret ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
import { createClient } from "jsr:@supabase/supabase-js@2";

const FREE_AI_PER_MONTH = 20;
const MODEL = "claude-haiku-5-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function buildPrompt(message: string, catalog: unknown) {
  return `You read a customer's message sent to a small online shop in Morocco and extract the order.
The message can mix Moroccan Darija (in Latin letters with numbers like 3, 7, 9 — or in Arabic script), French, Arabic and English, with typos and in any order.
The shop's products (JSON): ${JSON.stringify(catalog)}
Reply with ONLY one JSON object and nothing else:
{"name": the customer's name (first and family name if given; never a product, city or street) or null,
 "phone": Moroccan number as 10 digits starting with 05, 06 or 07 (convert +212 or 00212 to 0) or null,
 "city": Moroccan city in its usual French spelling (e.g. Casablanca, Fès, Tétouan, Marrakech) or null,
 "address": delivery address without the city and name: neighborhood (hay/quartier), street (zanqa/rue/bd), building, apartment, lot, number, landmark — or null,
 "productId": the id of the catalog product the customer wants, or null if none matches,
 "productAsked": what the customer asked for in their own words if no catalog product matches, else null,
 "qty": number of items (Darija: wa7d=1, joj/jouj/zouj=2, tlata=3, rb3a=4), default 1,
 "note": short useful details for the seller such as size, color, delivery time or a question the customer asked, else null}
Message:
"""${message}"""`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Who is asking?
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) return reply({ error: "not_signed_in" }, 401);

    // Plan and monthly AI allowance
    const { data: p } = await admin.from("profiles").select("*").eq("id", user.id).single();
    if (!p) return reply({ error: "no_profile" }, 404);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const used = p.ai_month === month ? p.ai_used : 0;
    const pro = p.plan === "pro" && (!p.pro_until || p.pro_until >= today);
    if (!pro && used >= FREE_AI_PER_MONTH) return reply({ error: "limit", used, limit: FREE_AI_PER_MONTH }, 402);

    // The message and the seller's products
    const body = await req.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message.slice(0, 2500) : "";
    const catalog = Array.isArray(body.catalog) ? body.catalog.slice(0, 300) : [];
    if (!message.trim()) return reply({ error: "empty" }, 400);

    // Ask Claude
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content: buildPrompt(message, catalog) }] }),
    });
    if (!r.ok) return reply({ error: "ai_failed", status: r.status }, 502);
    const out = await r.json();
    const text = (out.content || []).map((c: { text?: string }) => c.text || "").join("");
    let result = null;
    try { result = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { result = JSON.parse(m[0]); } catch { /* ignore */ } } }
    if (!result) return reply({ error: "unreadable" }, 502);

    // Count this read
    await admin.from("profiles").update({ ai_month: month, ai_used: used + 1 }).eq("id", user.id);
    return reply({ result, pro, used: used + 1, limit: pro ? null : FREE_AI_PER_MONTH });
  } catch (_e) {
    return reply({ error: "server_error" }, 500);
  }
});
