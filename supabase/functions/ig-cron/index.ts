// Edge Function: ig-cron
// El "reloj" de Instagram del panel. Corre cada 5 minutos (pg_cron) y hace 2 cosas:
//   1) Mantiene vivo el token de Instagram: lo guarda en la tabla ig_tokens y lo renueva
//      cada ~7 días (los tokens de Instagram vencen a los 60; renovándolos nunca mueren).
//   2) Llama a publicar-ig para publicar las piezas programadas que ya vencieron.
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

async function refrescar(token: string): Promise<string | null> {
  try {
    const r = await fetch(`${IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) return String(j.access_token);
    return null; // token muy nuevo (<24h) o error: se sigue usando el actual
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

    const admin = createClient(SB_URL, SERVICE || SB_ANON);
    const resumen: Record<string, unknown> = {};

    // ---- 1) Token: sembrar desde el secret si la tabla está vacía; renovar cada 7 días ----
    const { data: fila } = await admin.from("ig_tokens").select("*").eq("id", 1).maybeSingle();
    if (!fila) {
      const semilla = Deno.env.get("IG_ACCESS_TOKEN");
      if (semilla) {
        const nuevo = (await refrescar(semilla)) || semilla;
        await admin.from("ig_tokens").upsert({ id: 1, access_token: nuevo, updated_at: new Date().toISOString() });
        resumen.token = "sembrado" + (nuevo !== semilla ? " y renovado" : "");
      } else {
        resumen.token = "sin token (falta IG_ACCESS_TOKEN)";
      }
    } else {
      const edadDias = (Date.now() - new Date(fila.updated_at).getTime()) / 86400000;
      if (edadDias >= 7) {
        const nuevo = await refrescar(fila.access_token);
        if (nuevo) {
          await admin.from("ig_tokens").update({ access_token: nuevo, updated_at: new Date().toISOString() }).eq("id", 1);
          resumen.token = "renovado";
        } else {
          resumen.token = "no se pudo renovar (se reintenta en la próxima corrida)";
        }
      } else {
        resumen.token = "vigente";
      }
    }

    // ---- 2) Publicar las programadas vencidas (delegado a publicar-ig) ----
    try {
      const r = await fetch(`${SB_URL}/functions/v1/publicar-ig`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json" },
        body: "{}",
      });
      resumen.publicar = await r.json().catch(() => ({ error: "respuesta inválida" }));
    } catch (e) { resumen.publicar = { error: String((e as Error).message) }; }

    return json({ ok: true, ...resumen });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
