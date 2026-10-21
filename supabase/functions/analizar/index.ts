// Edge Function: analizar — AGENTE 2 (cerebro de análisis / receta de venta)
// Lee los deals cerrados (ganado / perdido / no-decisión) + sus conversaciones (touches)
// y destila una "receta de venta" versionada con reglas accionables + evidencia.
// Honestidad estadística: <8 cierres = modo observación/cualitativo, sin conclusiones duras.
// Guarda cada corrida en la tabla `recetas` (versionada). Se dispara desde la pestaña ANÁLISIS.
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
    let p = (t || "").split(".")[1];
    if (!p) return null;
    p = p.replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(atob(p)).role || null;
  } catch { return null; }
}

const corta = (s: unknown, n: number) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });

    const token = (auth || "").replace(/^Bearer\s+/i, "");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    let allowed = (!!SERVICE && token === SERVICE) || jwtRole(token) === "service_role";
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    const admin = createClient(SB_URL, SERVICE || SB_ANON);

    // ===== 1. Juntar los datos =====
    const [ldR, tcR, reR] = await Promise.all([
      admin.from("leads").select("*").order("created_at", { ascending: false }),
      admin.from("touches").select("*").order("created_at", { ascending: true }),
      admin.from("reply_examples").select("*").order("created_at", { ascending: false }).limit(10),
    ]);
    const leads = ldR.data || [];
    const touches = tcR.data || [];
    const ejemplos = (reR && !reR.error && reR.data) ? reR.data : [];

    const ahora = Date.now();
    const DIA = 86400000;
    const touchesDe = (id: string) => touches.filter((t: any) => t.lead_id === id);

    // 3 salidas: ganado / perdido / no-decisión (desapareció: sin respuesta prolongada con toques hechos)
    const ganados = leads.filter((l: any) => l.status === "ganado");
    const perdidos = leads.filter((l: any) => l.status === "perdido");
    const noDecision = leads.filter((l: any) => {
      if (l.status === "ganado" || l.status === "perdido") return false;
      const ts = touchesDe(l.id);
      if (ts.length < 2) return false;
      const ultimo = ts[ts.length - 1];
      return (ahora - new Date(ultimo.created_at).getTime()) > 30 * DIA;
    });

    const cierres = ganados.length + perdidos.length;
    const modo = cierres >= 8 ? "estadistico" : cierres >= 1 ? "cualitativo" : "observacion";

    // Sin ningún cierre: no gastamos análisis — el agente queda esperando datos.
    if (cierres === 0 && noDecision.length === 0) {
      return json({
        sinDatos: true, modo,
        mensaje: "Todavía no hay deals cerrados (ganados/perdidos) ni no-decisiones para analizar. El agente queda listo: cuando cierres los primeros, corré el análisis de nuevo.",
      });
    }

    // ===== 2. Armar el expediente por deal (acotado para no inflar el prompt) =====
    const expediente = (l: any, salida: string) => {
      const ts = touchesDe(l.id).slice(0, 14).map((t: any) =>
        `  [${String(t.created_at).slice(0, 16)}] ${t.tipo}${t.resultado ? " (" + t.resultado + ")" : ""}: ${corta(t.texto, 500)}`
      ).join("\n");
      const primerMail = touchesDe(l.id).find((t: any) => t.tipo === "mail");
      const horas1a = primerMail ? ((new Date(primerMail.created_at).getTime() - new Date(l.created_at).getTime()) / 3600000).toFixed(1) : "s/d";
      return `--- DEAL (${salida}) — ${corta(l.name || l.email, 60)} · rubro: ${l.service || "s/d"} · idioma: ${l.idioma || "s/d"}
  1a respuesta: ${horas1a} h desde que entró · toques: ${touchesDe(l.id).length}
  Mensaje inicial del lead: ${corta(l.message, 400)}
  ${salida !== "GANADO" ? `Motivo anotado: ${l.cierre_motivo || "s/d"} · Qué faltó: ${l.cierre_falto || "s/d"} · Obs: ${corta(l.cierre_obs, 200)}` : `Obs del cierre: ${corta(l.cierre_obs, 200)}`}
  Conversación:\n${ts || "  (sin toques registrados)"}`;
    };

    const cuerpo = [
      ...ganados.slice(0, 12).map((l: any) => expediente(l, "GANADO")),
      ...perdidos.slice(0, 12).map((l: any) => expediente(l, "PERDIDO")),
      ...noDecision.slice(0, 8).map((l: any) => expediente(l, "NO-DECISION")),
    ].join("\n\n");

    const ejTxt = ejemplos.slice(0, 6).map((e: any) =>
      `- Sugerido: ${corta(e.sugerido || e.suggestion, 250)}\n  Aprobado: ${corta(e.aprobado || e.final || e.approved, 250)}`
    ).join("\n");

    const muestra = `${ganados.length} ganados / ${perdidos.length} perdidos / ${noDecision.length} no-decisión`;

    // ===== 3. Prompt de análisis (marco win/loss del playbook) =====
    const sys = `Sos el AGENTE 2 de LORENZO Agency (Miami): analista de revenue especializado en win/loss.
Tu trabajo: leer los deals REALES (conversaciones completas) y destilar una "receta de venta" accionable.

MARCO DE ANÁLISIS (en este orden):
1. MOTIVO REAL de cada perdido — clasificalo DESDE LA CONVERSACIÓN con esta taxonomía (puede llevar
   más de una etiqueta): gap-de-oferta | precio-valor-percibido | ejecucion-de-venta (lento, poco
   seguimiento, no propuso llamada/visita) | confianza-credibilidad | timing-presupuesto | no-decision.
   El "motivo anotado" por el vendedor está mal el 50-70% de las veces: si difiere de lo que muestra
   la conversación, señalá la discrepancia. "Precio" casi siempre es proxy de valor percibido o confianza.
2. DÓNDE SE ENFRIÓ cada perdido/no-decisión: el momento exacto (qué mail/llamada) y las señales de
   stall (respuestas más cortas o lentas, lenguaje vago, "lo vemos más adelante").
3. PATRONES DE GANADOS: qué factores se repiten (con frecuencia: "en 2 de 3 ganados...").
4. EJECUCIÓN vs benchmarks verificados: 1a respuesta <1 h (multiplica ~7x la calificación);
   ~6 toques capturan la mayoría de conversiones y >7 rinde negativo; ¿se propuso llamada/visita
   temprano?; ¿se habló de valor antes que del número?
5. QUIÉN ARREGLA cada pérdida: la oferta (Facu), la ejecución (el agente de respuestas / el proceso),
   o nadie (timing del cliente).

REGLAS DE HONESTIDAD (obligatorias):
- Muestra actual: ${muestra} (${cierres} cierres). Modo: ${modo.toUpperCase()}.
- Con <8 cierres NO hay estadística: solo lectura cualitativa, y lo decís explícito en el informe.
  Las reglas con muestra chica son HIPÓTESIS a validar, no conclusiones.
- Cada regla lleva evidencia real + tamaño de muestra + confianza (alta/media/baja). Nada inventado.
- Las no-decisiones son categoría propia, no "perdidos".

SALIDA OBLIGATORIA: imprimí SOLO este bloque con JSON válido:
<RECETA>
{"modo":"${modo}","muestra":"${muestra}","informe":"análisis en 2-4 párrafos, directo, en español rioplatense: motivos reales (vs anotados), dónde se enfrían los deals, qué repiten los ganados","reglas":[{"regla":"acción concreta","para":"agente-respuestas | visita | oferta | proceso","evidencia":"qué viste y en cuántos casos","confianza":"alta | media | baja"}],"pregunta_comprador":"UNA pregunta corta para mandarle al próximo cerrado (ganado o perdido) y validar el motivo real"}
</RECETA>
Entre 3 y 8 reglas, ordenadas por impacto.`;

    const user = `DEALS:\n\n${cuerpo}\n\n${ejTxt ? "CÓMO EDITA FACU LOS BORRADORES DEL AGENTE (sugerido vs aprobado):\n" + ejTxt : ""}`;

    const KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
    const MDL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MDL, max_tokens: 2500, system: sys, messages: [{ role: "user", content: user }] }),
    });
    const txt = await r.text();
    if (!r.ok) return json({ error: "Claude " + r.status + ": " + txt.slice(0, 200) }, 502);
    const resp = JSON.parse(txt);
    const out = (resp.content || []).map((c: any) => c.text || "").join("");
    const m = out.match(/<RECETA>([\s\S]*?)<\/RECETA>/);
    if (!m) return json({ error: "El análisis no devolvió la receta en el formato esperado." }, 502);
    let receta: any;
    try { receta = JSON.parse(m[1]); } catch { return json({ error: "Receta con JSON inválido." }, 502); }

    // ===== 4. Guardar versionada =====
    const { data: prev } = await admin.from("recetas").select("version").order("version", { ascending: false }).limit(1);
    const version = ((prev && prev[0] && Number(prev[0].version)) || 0) + 1;
    const { error: insErr } = await admin.from("recetas").insert({
      version, modo: receta.modo || modo, muestra: receta.muestra || muestra,
      informe: receta.informe || "", reglas: receta.reglas || [],
      pregunta_comprador: receta.pregunta_comprador || null,
    });
    if (insErr) return json({ error: "No se pudo guardar la receta: " + insErr.message }, 500);

    return json({ ok: true, version, modo, muestra, informe: receta.informe, reglas: receta.reglas, pregunta_comprador: receta.pregunta_comprador || null });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
