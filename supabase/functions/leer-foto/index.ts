// Edge Function: leer-foto
// Recibe una foto (tarjeta personal, flyer, cartel, captura) y extrae los datos del
// negocio/persona para autocompletar el formulario de carga manual de Captación.
// Usa el mismo ANTHROPIC_API_KEY que generar-contenido.
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

    const body = await req.json().catch(() => ({}));
    const imagen = String(body.imagen || "");
    const media = String(body.media_type || "image/jpeg");
    if (!imagen || imagen.length < 100) return json({ error: "Falta la imagen" }, 400);
    if (imagen.length > 7_000_000) return json({ error: "La foto es muy pesada — probá con una más chica" }, 400);

    const KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
    const MDL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";

    const prompt = `Mirá esta foto (puede ser una tarjeta personal, un flyer, un cartel, una captura de pantalla o una foto de un local) y extraé los datos para cargar un negocio en un CRM de captación de clientes de Miami.

Devolvé SOLO un JSON válido (sin markdown, sin texto alrededor) con estos campos — los que no estén en la foto van como "" (NUNCA inventes nada):
{
  "empresa": "nombre del negocio/lugar",
  "contacto": "nombre de la persona + cargo si figura, formato 'Nombre — cargo'",
  "email": "email genérico del negocio (info@, hello@)",
  "email_directo": "email personal de la persona (nombre@...)",
  "phone": "teléfono general del negocio",
  "phone_directo": "celular/directo de la persona",
  "web": "dominio sin https://",
  "instagram": "@cuenta",
  "ciudad": "barrio/ciudad si figura (ej: 'Wynwood, Miami') o la que se deduzca de la dirección",
  "nicho": "rubro si se deduce (restaurante, lounge, gym...)",
  "notas": "dirección completa y cualquier otro dato útil de la foto (horarios, cargo, slogan) — corto, separado por ' · '"
}
Reglas:
- Si hay UN solo email y es de una persona con nombre, va en email_directo; si es info@/hello@/contact@, va en email.
- Si hay UN solo teléfono y la foto es una tarjeta personal, va en phone_directo; si es de un local/flyer, va en phone.
- El cargo de la persona SIEMPRE junto al nombre en "contacto" si figura.`;

    const lr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MDL,
        max_tokens: 700,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data: imagen } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    const lj = await lr.json().catch(() => ({}));
    if (!lr.ok) return json({ error: "LLM " + lr.status + ": " + (lj.error?.message || "error") }, 500);
    const texto = (lj.content || []).map((c: any) => c.text || "").join("");
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "No pude leer datos de esa foto" }, 422);
    let datos: Record<string, string> = {};
    try { datos = JSON.parse(m[0]); } catch { return json({ error: "No pude leer datos de esa foto" }, 422); }
    const campos = ["empresa","contacto","email","email_directo","phone","phone_directo","web","instagram","ciudad","nicho","notas"];
    const out: Record<string, string> = {};
    for (const c of campos) out[c] = typeof datos[c] === "string" ? datos[c].trim() : "";
    return json({ ok: true, datos: out });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
