// Edge Function: enviar
// Manda el email por SMTP (Private Email) y actualiza el lead:
//   status -> enviado, +1 al contador de mails, fechas, borrador guardado.
// Guarda el par (sugerencia -> texto final) en reply_examples para que el agente aprenda.
// Seguridad: admin (JWT del panel) O service_role (backend de SHAI). Credenciales SMTP en env.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

// Decodifica el payload del JWT (ya verificado por el gateway de Supabase) y devuelve el claim `role`.
// Sirve para aceptar la service_role sin depender de comparar la key byte a byte.
function jwtRole(t: string): string | null {
  try {
    let p = (t || "").split(".")[1];
    if (!p) return null;
    p = p.replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(atob(p)).role || null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });

    // Autorización: admin logueado (panel) O service_role (SHAI)
    const token = (auth || "").replace(/^Bearer\s+/i, "");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const esServicio = (!!SERVICE && token === SERVICE) || jwtRole(token) === "service_role";
    let allowed = esServicio;
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    // Con service_role conviene un cliente que no herede el JWT (bypassa RLS en las escrituras)
    const db = (SERVICE && token === SERVICE) ? createClient(SB_URL, SERVICE) : supa;

    const { lead_id, to, subject, body, suggestion = "" } = await req.json();
    if (!to || !body) return json({ error: "Falta destinatario o cuerpo" }, 400);

    const USER = Deno.env.get("SMTP_USER")!;          // email completo de la compañía
    const PASS = Deno.env.get("SMTP_PASS")!;          // contraseña del buzón Private Email
    const FROM = Deno.env.get("SMTP_FROM") || ("LORENZO Agency <" + USER + ">");

    // Firma fija al pie de todos los mails (vendedor de contacto)
    const FIRMA_TXT = "\n\n—\nNicolás Ferrer\nVentas · LORENZO Agency\nlorenzoagency.tech";
    const FIRMA_HTML =
      '<br><br><div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e5e5;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#444">' +
      '<strong style="color:#111">Nicolás Ferrer</strong><br>' +
      'Ventas · LORENZO Agency<br>' +
      '<a href="https://lorenzoagency.tech" style="color:#DD7D47;text-decoration:none">lorenzoagency.tech</a>' +
      '<img src="https://lorenzoagency.tech/email/firma-bigote.png" alt="LORENZO Agency" width="130" height="17" style="display:block;margin-top:11px;border:0;outline:none">' +
      '</div>';
    const bodyHtml = String(body).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");

    // Enviar por SMTP — Private Email: mail.privateemail.com, 465 SSL
    const client = new SMTPClient({
      connection: { hostname: "mail.privateemail.com", port: 465, tls: true, auth: { username: USER, password: PASS } },
    });
    await client.send({
      from: FROM,
      to,
      subject: subject || "Respuesta — LORENZO Agency",
      content: body + FIRMA_TXT,
      html: bodyHtml + FIRMA_HTML,
    });
    await client.close();

    // Actualizar el lead + aprendizaje
    if (lead_id) {
      const now = new Date().toISOString();
      const { data: cur } = await db.from("leads")
        .select("mails_enviados,fecha_primer_envio,service").eq("id", lead_id).maybeSingle();
      const envios = (cur?.mails_enviados || 0) + 1;
      await db.from("leads").update({
        status: "enviado",
        mails_enviados: envios,
        fecha_primer_envio: cur?.fecha_primer_envio || now,
        fecha_ultimo_envio: now,
        borrador: body,
      }).eq("id", lead_id);

      // Guardar el ejemplo (sirva o no haya habido edición, el final es oro)
      try {
        await db.from("reply_examples").insert({
          lead_id, service: cur?.service || null, suggestion: suggestion || null, final: body,
        });
      } catch (_e) { /* no romper el envío si falla el aprendizaje */ }
    }

    return json({ ok: true });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
