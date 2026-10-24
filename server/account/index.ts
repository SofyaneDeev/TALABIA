// Talabia account helper: log in with an email, send a "reset your password" email, save a seller's email.
// Accounts still sign in with their phone number (phone@talabia.app); the seller's real email is kept in profiles.email.
// Needs the secrets BREVO_API_KEY and BREVO_SENDER (the sender email confirmed in Brevo) to send emails.
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESET_PAGE = "https://sofyanedeev.github.io/TALABIA/reset.html";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

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
const URL_ = Deno.env.get("SUPABASE_URL")!;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const cleanEmail = (v: unknown) => String(v || "").trim().toLowerCase().slice(0, 254);
function cleanPhone(v: unknown) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("00212")) d = d.slice(5); else if (d.startsWith("212")) d = d.slice(3);
  if (d.length === 9 && /^[5-7]/.test(d)) d = "0" + d;
  return d;
}
const loginEmail = (phone: string) => phone + "@talabia.app";

const TEXT: Record<string, { subject: string; hi: string; body: string; button: string; ignore: string }> = {
  fr: { subject: "Réinitialiser votre mot de passe Talabia", hi: "Bonjour", body: "Vous avez demandé un nouveau mot de passe pour votre boutique Talabia. Appuyez sur le bouton ci-dessous. Le lien est valable 1 heure.", button: "Choisir un nouveau mot de passe", ignore: "Si ce n'est pas vous, ignorez cet email : votre mot de passe ne change pas." },
  ar: { subject: "إعادة تعيين كلمة مرور طلبية", hi: "مرحباً", body: "طلبت كلمة مرور جديدة لمتجرك في Talabia. اضغط على الزر أسفله. الرابط صالح لمدة ساعة.", button: "اختر كلمة مرور جديدة", ignore: "إذا لم تطلب ذلك، تجاهل هذه الرسالة: كلمة المرور لن تتغير." },
  en: { subject: "Reset your Talabia password", hi: "Hello", body: "You asked for a new password for your Talabia shop. Tap the button below. The link works for 1 hour.", button: "Choose a new password", ignore: "If this wasn't you, ignore this email: your password stays the same." },
};

async function sendResetEmail(to: string, shop: string, link: string, lang: string) {
  const key = Deno.env.get("BREVO_API_KEY"), sender = Deno.env.get("BREVO_SENDER");
  if (!key || !sender) { console.error("account: BREVO_API_KEY or BREVO_SENDER missing"); return false; }
  const t = TEXT[lang] || TEXT.fr, dir = lang === "ar" ? "rtl" : "ltr";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `<div dir="${dir}" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1d1a">
<h2 style="color:#0f6b4f;margin:0 0 16px">Talabia.</h2>
<p>${t.hi}${shop ? " " + esc(shop) : ""},</p><p>${t.body}</p>
<p style="margin:28px 0"><a href="${link}" style="background:#0f6b4f;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:bold">${t.button}</a></p>
<p style="color:#64685f;font-size:13px">${t.ignore}</p></div>`;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: "Talabia", email: sender }, to: [{ email: to }], subject: t.subject, htmlContent: html }),
  });
  if (!r.ok) console.error("account: Brevo error", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method" }, 405);
  try {
    const admin = createClient(URL_, serverKey(), { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // 1. Log in with an email (accounts sign in with phone@talabia.app behind the scenes)
    if (action === "login-email") {
      const email = cleanEmail(body.email), password = String(body.password || "");
      if (!EMAIL_RE.test(email) || password.length < 6) return reply({ error: "bad" }, 400);
      const { data: p } = await admin.from("profiles").select("phone").eq("email", email).maybeSingle();
      if (!p?.phone) return reply({ error: "bad" }, 400);
      const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") || serverKey(), "content-type": "application/json" },
        body: JSON.stringify({ email: loginEmail(p.phone), password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return reply({ error: r.status === 429 ? "busy" : "bad" }, r.status === 429 ? 429 : 400);
      return reply({ ...j, phone: p.phone });
    }

    // 2. Forgot password: always answer "sent" so nobody can find out which accounts exist
    if (action === "forgot") {
      const id = String(body.id || "").trim(), lang = ["fr", "ar", "en"].includes(body.lang) ? body.lang : "fr";
      const q = admin.from("profiles").select("id,phone,email,shop,reset_sent_at");
      const { data: p } = id.includes("@") ? await q.eq("email", cleanEmail(id)).maybeSingle() : await q.eq("phone", cleanPhone(id)).maybeSingle();
      if (!p) return reply({ ok: true });
      if (!p.email) return reply({ ok: true, noEmail: true });
      if (p.reset_sent_at && Date.now() - new Date(p.reset_sent_at).getTime() < 120000) return reply({ ok: true }); // one email every 2 minutes
      const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: loginEmail(p.phone) });
      if (error || !data?.properties?.hashed_token) { console.error("account: generateLink failed", error?.message); return reply({ ok: true }); }
      const link = `${RESET_PAGE}?t=${encodeURIComponent(data.properties.hashed_token)}&l=${lang}`;
      if (await sendResetEmail(p.email, p.shop || "", link, lang)) await admin.from("profiles").update({ reset_sent_at: new Date().toISOString() }).eq("id", p.id);
      return reply({ ok: true });
    }

    // 3. Save or change the signed-in seller's email
    if (action === "set-email") {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: { user }, error } = await admin.auth.getUser(token);
      if (error || !user) return reply({ error: "not_signed_in" }, 401);
      const email = cleanEmail(body.email);
      if (email && !EMAIL_RE.test(email)) return reply({ error: "invalid" }, 400);
      if (email) {
        const { data: other } = await admin.from("profiles").select("id").eq("email", email).neq("id", user.id).maybeSingle();
        if (other) return reply({ error: "taken" }, 409);
      }
      const { error: e2 } = await admin.from("profiles").update({ email }).eq("id", user.id);
      if (e2) return reply({ error: "server_error" }, 500);
      return reply({ ok: true, email });
    }
    return reply({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("account failed:", e);
    return reply({ error: "server_error" }, 500);
  }
});
