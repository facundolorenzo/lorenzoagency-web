// Edge Function: guardar-borrador
// Deposita un mail (destinatario + asunto + texto) en la carpeta Borradores de la casilla
// de Private Email (Namecheap) vía IMAP, para retocarlo y enviarlo desde el mail real.
// Secrets necesarios: MAIL_USER (ej. talk@lorenzoagency.tech) y MAIL_PASS.
// Opcionales: MAIL_HOST (default mail.privateemail.com), MAIL_DRAFTS (default "Drafts").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

function jwtRole(t: string): string | null {
  try {
    let p = (t || "").split(".")[1]; if (!p) return null;
    p = p.replace(/-/g, "+").replace(/_/g, "/"); p += "=".repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(atob(p)).role || null;
  } catch { return null; }
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64lines = (s: string) => (b64(s).match(/.{1,76}/g) || []).join("\r\n");
const qsubj = (s: string) => "=?UTF-8?B?" + b64(s) + "?=";
// Texto -> HTML: escapa, **asi** = negrita, y el saludo (primera linea) sale en negrita solo
function aHtml(txt: string): string {
  const lineas = txt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").split("\n");
  for (let i = 0; i < lineas.length; i++) { if (lineas[i].trim()) { if (!lineas[i].includes("<b>")) lineas[i] = "<b>" + lineas[i] + "</b>"; break; } }
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222">' + lineas.join("<br>") + "</div>";
}
const iquote = (s: string) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// APPEND por IMAP (una conexión, comandos mínimos). Devuelve la carpeta donde quedó.
async function imapAppendDraft(host: string, user: string, pass: string, carpetas: string[], mensaje: string): Promise<string> {
  const conn = await Deno.connectTls({ hostname: host, port: 993 });
  const enc = new TextEncoder(), dec = new TextDecoder();
  const buf = new Uint8Array(8192);
  const leer = async (): Promise<string> => { const n = await conn.read(buf); return n === null ? "" : dec.decode(buf.subarray(0, n)); };
  const hasta = async (pred: (s: string) => boolean, ms = 12000): Promise<string> => {
    let acc = ""; const t0 = Date.now();
    while (Date.now() - t0 < ms) { acc += await leer(); if (pred(acc)) return acc; }
    throw new Error("IMAP no respondió a tiempo");
  };
  const enviar = (s: string) => conn.write(enc.encode(s));
  try {
    await hasta(s => s.includes("OK"));
    await enviar("a1 LOGIN " + iquote(user) + " " + iquote(pass) + "\r\n");
    const r1 = await hasta(s => /a1 (OK|NO|BAD)/.test(s));
    if (!/a1 OK/.test(r1)) throw new Error("La casilla rechazó el usuario/contraseña (revisá MAIL_USER y MAIL_PASS)");
    const cuerpo = enc.encode(mensaje);
    let n = 2;
    for (const carpeta of carpetas) {
      const tag = "a" + (++n);
      await enviar(tag + " APPEND " + iquote(carpeta) + " (\\Draft) {" + cuerpo.length + "}\r\n");
      const r = await hasta(s => s.includes("+") || new RegExp(tag + " (NO|BAD)").test(s));
      if (new RegExp(tag + " (NO|BAD)").test(r)) continue; // esa carpeta no existe, probar la siguiente
      await conn.write(cuerpo);
      await enviar("\r\n");
      const r2 = await hasta(s => new RegExp(tag + " (OK|NO|BAD)").test(s));
      if (new RegExp(tag + " OK").test(r2)) { try { await enviar("a99 LOGOUT\r\n"); } catch { /* ok */ } return carpeta; }
    }
    throw new Error("No encontré la carpeta de borradores (probé: " + carpetas.join(", ") + ")");
  } finally { try { conn.close(); } catch { /* ok */ } }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const token = (auth || "").replace(/^Bearer\s+/i, "");
    let allowed = (!!SERVICE && token === SERVICE) || jwtRole(token) === "service_role";
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    const USER = Deno.env.get("MAIL_USER") || Deno.env.get("SMTP_USER") || "";
    const PASS = Deno.env.get("MAIL_PASS") || Deno.env.get("SMTP_PASS") || "";
    if (!USER || !PASS) return json({ error: "Faltan los secrets MAIL_USER y MAIL_PASS en Supabase" }, 500);
    const HOST = Deno.env.get("MAIL_HOST") || "mail.privateemail.com";
    const DRAFTS = Deno.env.get("MAIL_DRAFTS") || "";

    const body = await req.json().catch(() => ({}));
    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").trim() || "LORENZO Agency";
    const texto = String(body.body || "").trim();
    if (!to || !to.includes("@")) return json({ error: "Falta el destinatario" }, 400);
    if (!texto) return json({ error: "Falta el texto del mail" }, 400);
    const adjuntos = (Array.isArray(body.adjuntos) ? body.adjuntos : []).slice(0, 5)
      .filter((a: Record<string, string>) => a && a.nombre && a.base64);

    const cab =
      "From: LORENZO Agency <" + USER + ">\r\n" +
      "To: " + to + "\r\n" +
      "Subject: " + qsubj(subject) + "\r\n" +
      "Date: " + new Date().toUTCString() + "\r\n" +
      "MIME-Version: 1.0\r\n";
    let msg: string;
    if (adjuntos.length) {
      const B = "----=_LZA_" + Math.random().toString(36).slice(2);
      let partes =
        "--" + B + "\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n" +
        "Content-Transfer-Encoding: base64\r\n\r\n" +
        b64lines(aHtml(texto)) + "\r\n";
      for (const a of adjuntos) {
        partes +=
          "--" + B + "\r\n" +
          "Content-Type: " + String(a.tipo || "application/octet-stream") + "; name=\"" + String(a.nombre).replace(/"/g, "") + "\"\r\n" +
          "Content-Disposition: attachment; filename=\"" + String(a.nombre).replace(/"/g, "") + "\"\r\n" +
          "Content-Transfer-Encoding: base64\r\n\r\n" +
          (String(a.base64).replace(/[^A-Za-z0-9+/=]/g, "").match(/.{1,76}/g) || []).join("\r\n") + "\r\n";
      }
      partes += "--" + B + "--\r\n";
      msg = cab + "Content-Type: multipart/mixed; boundary=\"" + B + "\"\r\n\r\n" + partes;
    } else {
      msg = cab +
        "Content-Type: text/html; charset=utf-8\r\n" +
        "Content-Transfer-Encoding: base64\r\n" +
        "\r\n" +
        b64lines(aHtml(texto)) + "\r\n";
    }

    const carpetas = DRAFTS ? [DRAFTS] : ["Drafts", "INBOX.Drafts", "Borradores"];
    const donde = await imapAppendDraft(HOST, USER, PASS, carpetas, msg);
    return json({ ok: true, carpeta: donde, nota: "Borrador guardado en tu casilla (" + USER + ")" });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
