// Edge Function: generar-contenido
// Genera las imágenes de un carrusel (una pieza de contenido_piezas) con Higgsfield.
// Flujo: idea -> el LLM arma los prompts + la descripción -> Higgsfield genera cada imagen
// (async, con poll) -> se descargan y suben a Storage (bucket contenido) -> se actualiza la pieza.
// Motor inicial: Marketing Studio Image. Diseñado para sumar más motores (Grok, Graphic ads).
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HF_BASE = "https://api.higgsfield.ai";

// ---- Higgsfield: Marketing Studio Image (modo directo: prompt + referencias) ----
async function hfMarketingStudio(key: string, prompt: string, refs: string[]): Promise<string> {
  const body: Record<string, unknown> = {
    prompt,
    resolution: "2k",
    aspect_ratio: "1:1",   // IG usa 4:5 pero no está soportado; 1:1 es el más seguro
    enhance_prompt: false,
  };
  if (refs && refs.length) body.image_urls = refs.slice(0, 2); // directo acepta refs para guiar
  const r = await fetch(HF_BASE + "/marketing-studio/image", {
    method: "POST",
    headers: { "Authorization": "Key " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("Higgsfield " + r.status + ": " + txt.slice(0, 180));
  let j: any; try { j = JSON.parse(txt); } catch { throw new Error("Higgsfield: respuesta no-JSON"); }
  // Puede venir ya con images, o con status_url para pollear
  if (Array.isArray(j.images) && j.images[0]?.url) return j.images[0].url;
  const statusUrl = j.status_url || (j.request_id ? HF_BASE + "/requests/" + j.request_id + "/status" : null);
  if (!statusUrl) throw new Error("Higgsfield: sin status_url ni imágenes");
  // Poll hasta completed / failed (acotado para no pasar el límite de la Edge Function)
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const s = await fetch(statusUrl, { headers: { "Authorization": "Key " + key } });
    const st = await s.json().catch(() => ({}));
    const estado = st.status;
    if (estado === "completed") {
      const url = Array.isArray(st.images) && st.images[0]?.url ? st.images[0].url : null;
      if (!url) throw new Error("Higgsfield: completed sin imagen");
      return url;
    }
    if (estado === "failed" || estado === "nsfw" || estado === "canceled") {
      throw new Error("Higgsfield: " + estado + (st.error ? " — " + st.error : ""));
    }
  }
  throw new Error("Higgsfield: timeout esperando la imagen");
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

    const admin = createClient(SB_URL, SERVICE || SB_ANON);
    const HF_KEY = Deno.env.get("HIGGSFIELD_API_KEY");
    if (!HF_KEY) return json({ error: "Falta HIGGSFIELD_API_KEY en los secrets" }, 500);
    const KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
    const MDL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";

    const { pieza_id } = await req.json();
    if (!pieza_id) return json({ error: "Falta pieza_id" }, 400);

    const { data: pieza, error: pe } = await admin.from("contenido_piezas").select("*").eq("id", pieza_id).maybeSingle();
    if (pe || !pieza) return json({ error: "No se encontró la pieza" }, 404);

    const n = Math.max(1, Math.min(10, Number(pieza.n_imagenes) || 4));
    const refs: string[] = Array.isArray(pieza.referencias)
      ? pieza.referencias.map((r: any) => (typeof r === "string" ? r : r?.url)).filter(Boolean) : [];

    // 1) El LLM arma los prompts (uno por imagen) + la descripción del post
    const sys = `Sos el director creativo de LORENZO Agency (agencia de marketing en Miami). A partir de una IDEA en criollo,
armás los prompts para generar un carrusel de Instagram con "Marketing Studio Image" (imágenes publicitarias/de campaña).
Reglas para que salga bien a la primera (y no gastar créditos):
- Cada prompt: específico y en INGLÉS, con estructura [sujeto] + [acción] + [contexto/lugar] + [composición] + [estilo] + [luz].
- Estética publicitaria/campaña premium, coherente entre las ${n} imágenes (mismo mundo visual).
- Enmarcado en POSITIVO (nunca "sin X"). Si va texto en la imagen, ponelo entre comillas y describí la tipografía.
- Las referencias cargadas guían el estilo; respetá esa dirección visual.
- La descripción (caption) va en español rioplatense, con gancho y un CTA, + 3-5 hashtags.
Devolvé SOLO este JSON válido, sin texto extra:
{"prompts":["prompt imagen 1","..."],"descripcion":"caption del post"}
Deben ser exactamente ${n} prompts.`;
    const user = `IDEA: ${pieza.idea || "(sin idea)"}\nReferencias cargadas: ${refs.length}\nCantidad de imágenes: ${n}`;
    const lr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MDL, max_tokens: 1500, system: sys, messages: [{ role: "user", content: user }] }),
    });
    const lt = await lr.text();
    if (!lr.ok) return json({ error: "LLM " + lr.status + ": " + lt.slice(0, 160) }, 502);
    const lj = JSON.parse(lt);
    const out = (lj.content || []).map((c: any) => c.text || "").join("");
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "El LLM no devolvió JSON" }, 502);
    let plan: any; try { plan = JSON.parse(m[0]); } catch { return json({ error: "JSON del LLM inválido" }, 502); }
    const prompts: string[] = (Array.isArray(plan.prompts) ? plan.prompts : []).slice(0, n);
    if (!prompts.length) return json({ error: "El LLM no armó prompts" }, 502);

    // 2) Generar cada imagen en paralelo con Higgsfield
    const resultados = await Promise.allSettled(prompts.map((p) => hfMarketingStudio(HF_KEY, p, refs)));

    // 3) Descargar las que salieron y subirlas a Storage
    const urls: string[] = [];
    const errores: string[] = [];
    for (let i = 0; i < resultados.length; i++) {
      const res = resultados[i];
      if (res.status !== "fulfilled") { errores.push("img " + (i + 1) + ": " + String(res.reason?.message || res.reason)); continue; }
      try {
        const imgResp = await fetch(res.value);
        const bytes = new Uint8Array(await imgResp.arrayBuffer());
        const path = "gen/" + pieza_id + "/" + Date.now() + "-" + i + ".png";
        const up = await admin.storage.from("contenido").upload(path, bytes, { contentType: "image/png", upsert: true });
        if (up.error) { errores.push("subida " + (i + 1) + ": " + up.error.message); continue; }
        const { data: pub } = admin.storage.from("contenido").getPublicUrl(path);
        urls.push(pub.publicUrl);
      } catch (e) { errores.push("img " + (i + 1) + ": " + String((e as Error).message)); }
    }

    if (!urls.length) return json({ error: "No se generó ninguna imagen", detalle: errores.slice(0, 4) }, 502);

    // 4) Guardar en la pieza
    const { error: ue } = await admin.from("contenido_piezas").update({
      imagenes: urls,
      descripcion: plan.descripcion || pieza.descripcion || null,
      prompt: prompts.join("\n---\n"),
      motor: "marketing-studio",
      updated_at: new Date().toISOString(),
    }).eq("id", pieza_id);
    if (ue) return json({ error: "No se pudo guardar: " + ue.message }, 500);

    return json({ ok: true, imagenes: urls.length, descripcion: plan.descripcion || null, errores });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
