// Edge Function: responder
// Para que SHAI responda un lead por voz. Flujo:
//   1) PREVIEW  -> {lead_id, texto} (tu dictado en español) -> devuelve el TEXTO FINAL en el idioma del lead
//                  (si el lead es inglés, lo traduce). SHAI te lee ese final y te pide confirmación. NO manda.
//   2) ENVIAR   -> {lead_id, final, send:true} -> manda ese texto final por SMTP y actualiza el lead.
//      (También acepta {lead_id, texto, send:true}: traduce y manda en un paso.)
// Seguridad: admin (JWT del panel) o service_role (backend de SHAI).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

function detectLang(txt: string): "es" | "en" {
  const t = " " + String(txt || "").toLowerCase() + " ";
  if (!t.trim()) return "es";
  let es = 0, en = 0;
  if (/[ñáéíóúü¿¡]/.test(t)) es += 3;
  const ES = [" que ", " los ", " las ", " una ", " para ", " con ", " por ", " pero ", " como ", " tengo ", " quiero ", " hola ", " gracias ", " precio ", " necesito ", " hacer ", " muy ", " más ", " mas ", " también ", " cómo ", " buenas ", " saludos "];
  const EN = [" the ", " you ", " your ", " and ", " for ", " with ", " have ", " want ", " hello ", " hi ", " thanks ", " thank ", " how ", " much ", " price ", " need ", " would ", " could ", " please ", " we ", " our ", " about ", " looking ", " interested "];
  for (const w of ES) if (t.includes(w)) es++;
  for (const w of EN) if (t.includes(w)) en++;
  return es >= en ? "es" : "en";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });

    const token = (auth || "").replace(/^Bearer\s+/i, "");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    let allowed = !!SERVICE && token === SERVICE;
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    const db = (SERVICE && token === SERVICE) ? createClient(SB_URL, SERVICE) : supa;
    const { lead_id, texto = "", final = "", send = false, subject = "" } = await req.json();
    if (!lead_id) return json({ error: "Falta lead_id" }, 400);

    const { data: lead } = await db.from("leads").select("*").eq("id", lead_id).maybeSingle();
    if (!lead) return json({ error: "Lead no encontrado" }, 404);
    const idioma: "es" | "en" = (lead.idioma as any) || detectLang(lead.message || "");

    // Traduce tu texto al idioma del lead (usa la rama translate de `sugerir`, to:"match" con la consulta como referencia)
    async function aIdiomaDelLead(t: string): Promise<string> {
      if (!t || idioma !== "en" || !SERVICE) return t; // español -> va igual
      try {
        const r = await fetch(SB_URL + "/functions/v1/sugerir", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE, apikey: SERVICE },
          body: JSON.stringify({ translate: true, to: "match", reference: lead.message || "", message: t }),
        });
        if (!r.ok) return t;
        const j = await r.json();
        return (j.reply || t);
      } catch { return t; }
    }

    // ===== PREVIEW: devolver el texto final en el idioma del lead (no manda) =====
    if (!send) {
      if (!texto && !final) return json({ error: "Falta 'texto' para previsualizar" }, 400);
      const f = final || await aIdiomaDelLead(texto);
      return json({ idioma, final: f, para_enviar: false });
    }

    // ===== ENVIAR =====
    const bodyTxt = (final || await aIdiomaDelLead(texto)).trim();
    if (!bodyTxt) return json({ error: "No hay texto para enviar" }, 400);
    if (!lead.email) return json({ error: "El lead no tiene email" }, 400);

    const USER = Deno.env.get("SMTP_USER")!;
    const PASS = Deno.env.get("SMTP_PASS")!;
    const FROM = Deno.env.get("SMTP_FROM") || ("LORENZO Agency <" + USER + ">");
    const asunto = subject || (lead.service ? ("Re: " + lead.service + " — LORENZO") : "Gracias por tu consulta — LORENZO");

    const client = new SMTPClient({
      connection: { hostname: "mail.privateemail.com", port: 465, tls: true, auth: { username: USER, password: PASS } },
    });
    await client.send({
      from: FROM,
      to: lead.email,
      subject: asunto,
      content: bodyTxt,
      html: String(bodyTxt).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>"),
    });
    await client.close();

    // Actualizar el lead + aprendizaje + avanzar seguimiento
    const now = new Date().toISOString();
    const envios = (lead.mails_enviados || 0) + 1;
    await db.from("leads").update({
      status: "enviado",
      mails_enviados: envios,
      fecha_primer_envio: lead.fecha_primer_envio || now,
      fecha_ultimo_envio: now,
      borrador: bodyTxt,
      borrador_traduccion_es: null, // se recomputa en el próximo checker
    }).eq("id", lead_id);
    try {
      await db.from("reply_examples").insert({ lead_id, service: lead.service || null, suggestion: lead.borrador || null, final: bodyTxt });
    } catch (_e) { /* el aprendizaje no debe romper el envío */ }
    try { await db.from("touches").insert({ lead_id, tipo: "mail", texto: bodyTxt }); } catch (_e) { /* idem */ }

    return json({ ok: true, to: lead.email, idioma, enviado: bodyTxt });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
