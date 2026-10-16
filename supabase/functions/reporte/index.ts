// Edge Function: reporte
// Devuelve el estado de ventas del panel en JSON, para que SHAI (Jai) lo lea y arme el reporte.
// Auth: admin (JWT del panel) o service_role (backend de Jai).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

// Detección de idioma (misma heurística que el panel/checker)
function detectLang(txt: string): "es" | "en" {
  const t = " " + String(txt || "").toLowerCase() + " ";
  if (!t.trim()) return "es";
  let es = 0, en = 0;
  if (/[ñáéíóúü¿¡]/.test(t)) es += 3;
  const ES = [" que ", " los ", " las ", " una ", " para ", " con ", " por ", " pero ", " como ", " tengo ", " quiero ", " hola ", " gracias ", " cuánto ", " cuanto ", " precio ", " necesito ", " hacer ", " muy ", " más ", " mas ", " también ", " cómo ", " buenas ", " saludos "];
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
    const esServicio = (!!SERVICE && token === SERVICE) || jwtRole(token) === "service_role";
    let allowed = esServicio;
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    // Con service_role conviene un cliente que no herede el JWT (bypassa RLS)
    const db = (SERVICE && token === SERVICE) ? createClient(SB_URL, SERVICE) : supa;

    // Traducir al español llamando a la rama translate de `sugerir` (fallback si falta en la base)
    async function traducir(texto: string): Promise<string | null> {
      if (!texto || !SERVICE) return null;
      try {
        const r = await fetch(SB_URL + "/functions/v1/sugerir", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE, apikey: SERVICE },
          body: JSON.stringify({ translate: true, message: texto }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.reply || null;
      } catch { return null; }
    }

    const { data: leads } = await db.from("leads").select("*").order("created_at", { ascending: false });
    const L = leads || [];
    const lang = (l: any) => l.idioma || detectLang(l.message || "");
    const nombre = (l: any) => l.name || l.email || "—";

    const cnt = (s: string) => L.filter((x: any) => x.status === s).length;
    const nuevos = cnt("nuevo"), enviados = cnt("enviado"), resp = cnt("respondio"), sinr = cnt("sin_respuesta"), gan = cnt("ganado"), perd = cnt("perdido");
    const contactados = enviados + resp + sinr + gan + perd;
    const tasaResp = contactados ? Math.round((resp / contactados) * 100) : 0;
    const tasaCierre = (gan + perd) ? Math.round((gan / (gan + perd)) * 100) : 0;
    const es = L.filter((l: any) => lang(l) === "es").length;
    const en = L.filter((l: any) => lang(l) === "en").length;

    // "Para hoy": nuevos, respondieron, y los que tienen toque vencido
    const now = Date.now();
    const vencido = (l: any) => l.next_action_at && new Date(l.next_action_at).getTime() <= now;
    const paraHoy = L.filter((l: any) =>
      l.status === "nuevo" || l.status === "respondio" ||
      (["enviado", "sin_respuesta"].includes(l.status) && vencido(l))
    ).map((l: any) => ({
      accion: l.status === "nuevo" ? "Responder" : l.status === "respondio" ? "Contestar" : (l.next_action_tipo === "llamada" ? "Llamar" : "Seguimiento"),
      nombre: nombre(l), email: l.email || null, idioma: lang(l),
    }));

    const nuevosDetalle = L.filter((l: any) => l.status === "nuevo").map((l: any) => ({ nombre: nombre(l), email: l.email || null, idioma: lang(l), servicio: l.service || null }));
    const calientes = L.filter((l: any) => l.status === "respondio").map((l: any) => ({ nombre: nombre(l), email: l.email || null, idioma: lang(l) }));

    // ===== REVISAR: por cada ítem a revisar, ORIGINAL + IDIOMA + TRADUCCIÓN al español =====
    // Usa la traducción guardada en la base; si falta y el lead es inglés, la traduce AHORA y la guarda (cache).
    const paraHoyLeads = L.filter((l: any) =>
      l.status === "nuevo" || l.status === "respondio" ||
      (["enviado", "sin_respuesta"].includes(l.status) && vencido(l))
    );
    const revisar: any[] = [];
    for (const l of paraHoyLeads) {
      const idi = lang(l);
      const esIngles = idi === "en";
      let mensaje_es = l.traduccion_es, borrador_es = l.borrador_traduccion_es, respuesta_es = l.respuesta_traduccion_es;
      const patch: Record<string, string | null> = {};
      if (esIngles) {
        if (l.message && mensaje_es == null) { mensaje_es = await traducir(l.message); patch.traduccion_es = mensaje_es; }
        if (l.borrador && borrador_es == null) { borrador_es = await traducir(l.borrador); patch.borrador_traduccion_es = borrador_es; }
        if (l.ultima_respuesta_texto && respuesta_es == null) { respuesta_es = await traducir(l.ultima_respuesta_texto); patch.respuesta_traduccion_es = respuesta_es; }
      } else {
        // español: la "traducción" es el mismo texto
        mensaje_es = mensaje_es ?? l.message ?? null;
        borrador_es = borrador_es ?? l.borrador ?? null;
        respuesta_es = respuesta_es ?? l.ultima_respuesta_texto ?? null;
      }
      if (Object.keys(patch).length) { try { await db.from("leads").update(patch).eq("id", l.id); } catch { /* cache best-effort */ } }
      revisar.push({
        id: l.id,
        nombre: nombre(l),
        email: l.email || null,
        idioma: idi,
        estado: l.status,
        accion: l.status === "nuevo" ? "Responder" : l.status === "respondio" ? "Contestar" : (l.next_action_tipo === "llamada" ? "Llamar" : "Seguimiento"),
        mensaje: l.message || null,            // lo que escribió el lead (original)
        mensaje_es: mensaje_es || null,        // traducción al español
        borrador: l.borrador || null,          // respuesta sugerida (original, en el idioma del lead)
        borrador_es: borrador_es || null,      // traducción al español del borrador
        respuesta: l.ultima_respuesta_texto || null,  // última respuesta del lead (original)
        respuesta_es: respuesta_es || null,    // traducción al español
      });
    }

    const resumenTexto =
      `Reporte LORENZO Agency. Tenés ${paraHoy.length} acciones para hoy. ` +
      `${nuevos} consultas nuevas sin contestar${nuevos ? ` (${nuevosDetalle.filter(n => n.idioma === "es").length} en español, ${nuevosDetalle.filter(n => n.idioma === "en").length} en inglés)` : ""}. ` +
      `${resp} leads respondieron y están calientes. ` +
      `Mandaste propuestas a ${enviados} que todavía no contestan. ` +
      `Cerraste ${gan} y perdiste ${perd}. Tasa de respuesta ${tasaResp} por ciento.`;

    return json({
      fecha: new Date().toISOString(),
      acciones_para_hoy: paraHoy.length,
      para_hoy: paraHoy,
      revisar,
      totales: { nuevos, enviados, respondieron: resp, sin_respuesta: sinr, ganados: gan, perdidos: perd },
      tasa_respuesta: tasaResp,
      tasa_cierre: tasaCierre,
      idioma: { es, en },
      nuevos_detalle: nuevosDetalle,
      calientes,
      resumen_texto: resumenTexto,
    });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
