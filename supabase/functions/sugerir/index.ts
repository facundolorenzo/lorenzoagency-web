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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const SB_URL = Deno.env.get("SUPABASE_URL")!;
    const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });

    const { data: isAdmin } = await supa.rpc("is_admin");
    if (!isAdmin) return json({ error: "No autorizado" }, 403);

    const { message = "", name = "", service = "", previous = "" } = await req.json();

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
        temperature: previous ? 1 : 0.7,
        system: sys,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) { const tx = await r.text(); return json({ error: "Claude " + r.status + ": " + tx.slice(0, 200) }, 502); }
    const out = await r.json();
    const reply = (out.content || []).map((c: { text?: string }) => c.text || "").join("").trim();
    return json({ reply });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
