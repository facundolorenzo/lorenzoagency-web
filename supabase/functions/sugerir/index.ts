// Edge Function: sugerir
// Genera una respuesta sugerida para un lead usando Claude.
// "Rehacer" la vuelve a llamar con temperatura alta y la versión previa para variar.
// Seguridad: solo admin (verifica is_admin con el JWT del usuario). La API key vive en env.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Perfil de LORENZO (9 bloques) — el "cerebro". Editá este texto para afinar cómo responde.
const PERFIL = `Sos el asistente de ventas de LORENZO Agency. Respondés consultas entrantes
en nombre de la agencia, con criterio comercial y tono humano.

== 1. IDENTIDAD ==
LORENZO Agency (Miami, FL) — agencia de producción de marketing, automatización de sistemas
y potenciación de venues/negocios. No solo "pone música" ni "hace marketing": identifica el
concepto de cada lugar/negocio, arma un plan y lo ejecuta. Tono de marca: directo, seguro,
cálido y profesional. Nada robótico, nada de relleno corporativo vacío. Idiomas: español e inglés
(responde en el idioma de quien consulta).

== 2. QUÉ VENDE ==
- Producción de marketing (contenido, campañas, identidad).
- Automatización de sistemas (paneles, agentes de IA, flujos que ahorran tiempo/plata).
- Dirección y producción para venues (música como gancho, concepto, experiencia, consumo).

== 3. NICHO Y CLIENTE IDEAL ==
Venues (bares, lounges, discotecas), negocios gastronómicos, y empresas que quieren
automatizar ventas/operaciones. Dolores típicos: poca gente, bajo consumo, procesos manuales,
marketing sin estrategia.

== 4. PLAYBOOK (FAQs y objeciones) ==
- "¿Qué hacen exactamente?" → explicar el enfoque integral (concepto + plan + ejecución).
- "¿Cuánto sale?" → no tirar precio sin entender el caso; proponer una llamada corta para cotizar.
- "Ya tengo alguien de marketing" → diferenciar: LORENZO integra música/concepto/automatización.

== 5. PROCESO DE VENTA ==
Objetivo de cada respuesta: entender la necesidad, mostrar que LORENZO la resuelve, proponer el
próximo paso (llamada / visita al venue / propuesta). Escalar a Facu cuando piden precio cerrado.

== 6. REGLAS Y LÍMITES ==
- No prometer precios ni plazos cerrados sin confirmación de Facu.
- No inventar servicios que no ofrecemos.
- Nunca sonar como bot. Nunca exagerar ni prometer resultados garantizados.

== 7. EJEMPLOS APROBADOS ==
(Se cargan solos a medida que Facu edita y envía respuestas.)

== 8. CONTEXTO DEL DÍA ==
(Opcional: promos o foco de venta del momento.)

== 9. ESTÁNDAR DE MERCADO ==
Responder como una empresa corporativa de EE.UU.: profesional pero humano, concreto, sin vueltas.
En inglés, registro de negocios estadounidense.`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

// Decodifica el payload del JWT (ya verificado por el gateway) y devuelve el claim `role`.
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
    console.log("sugerir: inicio");
    const auth = req.headers.get("Authorization") || "";
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });

    // Permitido si es admin (panel) o si el que llama trae la service_role key (checker/backend)
    const token = (auth || "").replace(/^Bearer\s+/i, "");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    let allowed = (!!SERVICE && token === SERVICE) || jwtRole(token) === "service_role";
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    const body = await req.json();
    const { message = "", name = "", service = "", previous = "", translate = false, classify = false } = body;

    // ===== Rama CLASIFICAR: ¿es una consulta real de una persona, o promo/automático? =====
    // Devuelve { consulta: true|false }. La usa el checker antes de crear un lead desde un email.
    if (classify) {
      const KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
      const MDL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
      const rc = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: MDL,
          max_tokens: 5,
          system: `Clasificá un email que llegó al buzón de una agencia (LORENZO Agency).
Respondé SOLO "SI" o "NO".
"SI" = es una consulta/mensaje REAL de una persona: pregunta por servicios, quiere contratar, pide presupuesto, consulta algo concreto, responde a una propuesta, quiere reunirse.
"NO" = es promoción, newsletter, publicidad, notificación automática, factura de un proveedor, cobro, verificación de cuenta, spam, o cualquier cosa que NO sea una persona consultando por el negocio.
Ante la duda, respondé NO.`,
          messages: [{ role: "user", content: (message || "").slice(0, 2000) }],
        }),
      });
      if (!rc.ok) { const tx = await rc.text(); return json({ error: "Claude " + rc.status + ": " + tx.slice(0, 200) }, 502); }
      const oc = await rc.json();
      const ans = (oc.content || []).map((c: { text?: string }) => c.text || "").join("").trim().toUpperCase();
      return json({ consulta: ans.startsWith("SI") || ans.startsWith("SÍ") });
    }

    // ===== Rama TRADUCIR =====
    //  translate:true, message                       -> traduce al español (para leer/editar)
    //  translate:true, to:"match", reference, message -> traduce el message al MISMO idioma del reference (para enviar)
    if (translate) {
      const KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
      const MDL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
      const toMatch = body.to === "match" && body.reference;
      const sysT = toMatch
        ? "Traducí el TEXTO al MISMO idioma del texto de REFERENCIA (si la referencia está en inglés, traducí al inglés). Natural, fiel y en registro de negocios. Devolvé SOLO la traducción, sin comentarios, sin comillas, sin notas. Mantené el formato (saltos de línea, firma)."
        : "Traducí al español rioplatense, fiel y natural. Devolvé SOLO la traducción, sin comentarios, sin comillas, sin notas. Mantené el formato (saltos de línea, firma).";
      const userT = toMatch
        ? `REFERENCIA (idioma destino):\n${body.reference}\n\nTEXTO A TRADUCIR:\n${message}`
        : message;
      const rt = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: MDL,
          max_tokens: 1200,
          system: sysT,
          messages: [{ role: "user", content: userT }],
        }),
      });
      if (!rt.ok) { const tx = await rt.text(); return json({ error: "Claude " + rt.status + ": " + tx.slice(0, 200) }, 502); }
      const ot = await rt.json();
      const tr = (ot.content || []).map((c: { text?: string }) => c.text || "").join("").trim();
      return json({ reply: tr });
    }

    // Ejemplos aprobados del mismo rubro → aprendizaje (bloque 7)
    let ejemplos: Array<{ suggestion?: string; final?: string }> = [];
    try {
      let q = supa.from("reply_examples").select("suggestion,final,service").order("created_at", { ascending: false }).limit(6);
      if (service) q = q.eq("service", service);
      const { data } = await q;
      ejemplos = data || [];
    } catch (_e) { /* la tabla puede no existir todavía */ }

    const ejemplosTxt = ejemplos.length
      ? "\n\nEJEMPLOS DE RESPUESTAS QUE EL DUEÑO APROBÓ (imitá el estilo y criterio):\n" +
        ejemplos.map((e, i) => `--- Ejemplo ${i + 1} ---\n${e.final || e.suggestion || ""}`).join("\n\n")
      : "";

    const variar = previous
      ? "\n\nEl dueño pidió OTRA versión, distinta a esta (no la repitas, cambiá el enfoque):\n" + previous
      : "";

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
    const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
    console.log("sugerir: autorizado, llamando a Claude con modelo", MODEL, "key?", ANTHROPIC_KEY ? "sí" : "NO");

    const sys = PERFIL + ejemplosTxt + `

TAREA: redactá SOLO el cuerpo del email de respuesta a la consulta. Reglas:
- Tono humano y profesional de la marca (nunca robótico ni exagerado).
- Respondé lo que preguntan, conectá con el servicio que encaja y proponé un próximo paso concreto.
- Breve: 4 a 8 líneas.
- Idioma: el MISMO de la consulta.
- Si no sabés el nombre, no uses saludo genérico con corchetes.
- Cerrá firmando como LORENZO Agency.
- Devolvé ÚNICAMENTE el texto del email, sin asunto ni comentarios.`;

    const user = `Consulta entrante${name ? ` de ${name}` : ""}${service ? ` (rubro: ${service})` : ""}:\n\n${message}${variar}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        system: sys,
        messages: [{ role: "user", content: user }],
      }),
    });
    console.log("sugerir: Claude respondió status", r.status);
    if (!r.ok) { const tx = await r.text(); console.error("sugerir: Claude error", r.status, tx.slice(0, 300)); return json({ error: "Claude " + r.status + ": " + tx.slice(0, 200) }, 502); }
    const out = await r.json();
    const reply = (out.content || []).map((c: { text?: string }) => c.text || "").join("").trim();
    return json({ reply });
  } catch (err) {
    console.error("sugerir: EXCEPCIÓN", (err as Error)?.stack || String(err));
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
