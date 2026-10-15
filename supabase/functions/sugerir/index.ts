// Edge Function: sugerir
// Genera una respuesta sugerida para un lead usando Claude.
// "Rehacer" la vuelve a llamar con temperatura alta y la versión previa para variar.
// Seguridad: solo admin (verifica is_admin con el JWT del usuario). La API key vive en env.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PERFIL } from "../_shared/perfil.ts";

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
