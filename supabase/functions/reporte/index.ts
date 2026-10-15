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
    let allowed = !!SERVICE && token === SERVICE;
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    // Con service_role conviene un cliente que no herede el JWT (bypassa RLS)
    const db = (SERVICE && token === SERVICE) ? createClient(SB_URL, SERVICE) : supa;
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
