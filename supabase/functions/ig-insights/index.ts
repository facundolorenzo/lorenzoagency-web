// Edge Function: ig-insights
// Lee los posts publicados en Instagram (tech.lorenzoagency) y guarda sus métricas en la
// tabla ig_metricas, uniéndolas con la pieza del panel (contenido_piezas.ig_media_id).
// Es la fuente de datos de contenido del Agente 2: qué carruseles funcionan y cuáles no.
// Se puede invocar a mano o por cron. Requiere secret IG_ACCESS_TOKEN.
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

const IG = "https://graph.instagram.com";

async function igGet(path: string): Promise<any> {
  const r = await fetch(IG + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Instagram: " + (j.error?.message || ("HTTP " + r.status)));
  return j;
}

// Pide insights de un post; si el set completo falla (métricas que cambian por versión),
// reintenta con el set mínimo. Devuelve {nombre: valor}.
async function igInsights(mediaId: string, token: string): Promise<Record<string, number>> {
  const sets = [
    "views,reach,likes,comments,saved,shares,total_interactions",
    "reach,saved,shares,total_interactions",
    "reach",
  ];
  for (const metricas of sets) {
    try {
      const j = await igGet(`/${mediaId}/insights?metric=${metricas}&access_token=${encodeURIComponent(token)}`);
      const out: Record<string, number> = {};
      for (const d of (j.data || [])) {
        const v = Array.isArray(d.values) && d.values[0] ? d.values[0].value : d.total_value?.value;
        if (d.name && typeof v === "number") out[d.name] = v;
      }
      if (Object.keys(out).length) return out;
    } catch { /* probar el siguiente set */ }
  }
  return {};
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
    const IG_TOKEN = Deno.env.get("IG_ACCESS_TOKEN");
    if (!IG_TOKEN) return json({ error: "Falta IG_ACCESS_TOKEN en los secrets" }, 500);
    const IG_USER = Deno.env.get("IG_USER_ID") || "17841453364210675";

    // 1) Posts publicados en la cuenta (los últimos 50)
    const media = await igGet(`/${IG_USER}/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=50&access_token=${encodeURIComponent(IG_TOKEN)}`);
    const posts: any[] = media.data || [];
    if (!posts.length) return json({ ok: true, posts: 0, nota: "La cuenta todavía no tiene posts publicados." });

    // 2) Mapa post -> pieza del panel (por ig_media_id)
    const { data: piezas } = await admin.from("contenido_piezas").select("id, ig_media_id").not("ig_media_id", "is", null);
    const porMedia: Record<string, string> = {};
    for (const p of (piezas || [])) if (p.ig_media_id) porMedia[String(p.ig_media_id)] = p.id;

    // 3) Métricas por post + upsert
    let actualizados = 0; const errores: string[] = [];
    for (const post of posts) {
      try {
        const ins = await igInsights(String(post.id), IG_TOKEN);
        const fila = {
          media_id: String(post.id),
          pieza_id: porMedia[String(post.id)] || null,
          caption: post.caption ? String(post.caption).slice(0, 2000) : null,
          permalink: post.permalink || null,
          publicado_en: post.timestamp || null,
          likes: typeof post.like_count === "number" ? post.like_count : (ins.likes ?? null),
          comentarios: typeof post.comments_count === "number" ? post.comments_count : (ins.comments ?? null),
          alcance: ins.reach ?? null,
          guardados: ins.saved ?? null,
          compartidos: ins.shares ?? null,
          vistas: ins.views ?? null,
          interacciones: ins.total_interactions ?? null,
          raw: ins,
          updated_at: new Date().toISOString(),
        };
        const { error } = await admin.from("ig_metricas").upsert(fila, { onConflict: "media_id" });
        if (error) errores.push(post.id + ": " + error.message); else actualizados++;
      } catch (e) { errores.push(post.id + ": " + String((e as Error).message)); }
    }

    return json({ ok: true, posts: posts.length, actualizados, errores: errores.slice(0, 5) });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
