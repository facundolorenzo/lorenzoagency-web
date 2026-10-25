// Edge Function: publicar-ig
// Publica piezas de contenido_piezas en Instagram (cuenta tech.lorenzoagency) con la Instagram API.
// Modos:
//   { pieza_id } -> publica esa pieza YA.
//   {} (sin pieza_id) -> publica todas las piezas "programado" cuya fecha/hora ya venció (para el cron).
// Requiere secrets: IG_ACCESS_TOKEN (token de la cuenta, generado en Meta developers).
// Opcional: IG_USER_ID (default: tech.lorenzoagency).
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

const IG = "https://graph.instagram.com";

async function igPost(path: string, params: Record<string, string>): Promise<any> {
  const r = await fetch(IG + path, { method: "POST", body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Instagram: " + (j.error?.message || ("HTTP " + r.status)));
  return j;
}

// Espera a que un contenedor de media quede listo para publicar
async function igEsperar(id: string, token: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${IG}/${id}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    const j = await r.json().catch(() => ({}));
    if (j.status_code === "FINISHED") return;
    if (j.status_code === "ERROR" || j.error) throw new Error("Instagram: el contenedor falló" + (j.error?.message ? " — " + j.error.message : ""));
    await sleep(3000);
  }
  throw new Error("Instagram: timeout preparando la publicación");
}

async function publicarPieza(admin: any, pieza: any, token: string, igUser: string): Promise<string> {
  const imgs: string[] = (Array.isArray(pieza.imagenes) ? pieza.imagenes : []).filter(Boolean);
  if (!imgs.length) throw new Error("La pieza no tiene imágenes generadas");
  const caption = String(pieza.descripcion || "");

  let creationId: string;
  if (imgs.length === 1) {
    const c = await igPost(`/${igUser}/media`, { image_url: imgs[0], caption, access_token: token });
    await igEsperar(c.id, token);
    creationId = c.id;
  } else {
    // Carrusel: contenedores hijos -> contenedor carrusel -> publicar
    const hijos: string[] = [];
    for (const u of imgs.slice(0, 10)) {
      const c = await igPost(`/${igUser}/media`, { image_url: u, is_carousel_item: "true", access_token: token });
      hijos.push(c.id);
    }
    for (const h of hijos) await igEsperar(h, token);
    const car = await igPost(`/${igUser}/media`, {
      media_type: "CAROUSEL", children: hijos.join(","), caption, access_token: token,
    });
    await igEsperar(car.id, token);
    creationId = car.id;
  }
  const pub = await igPost(`/${igUser}/media_publish`, { creation_id: creationId, access_token: token });
  await admin.from("contenido_piezas").update({ estado: "publicado", ig_media_id: String(pub.id || "") || null, updated_at: new Date().toISOString() }).eq("id", pieza.id);
  return String(pub.id || "");
}

// Fecha y hora actuales en Miami (America/New_York)
function ahoraMiami(): { fecha: string; hora: string } {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const p = (n: number) => String(n).padStart(2, "0");
  return { fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hora: `${p(d.getHours())}:${p(d.getMinutes())}` };
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

    let body: any = {}; try { body = await req.json(); } catch { /* sin body = modo cron */ }

    // Modo 1: publicar una pieza puntual
    if (body.pieza_id) {
      const { data: pieza, error: pe } = await admin.from("contenido_piezas").select("*").eq("id", body.pieza_id).maybeSingle();
      if (pe || !pieza) return json({ error: "No se encontró la pieza" }, 404);
      if (pieza.cuenta !== "ag") return json({ error: "Solo la cuenta LORENZO Agency está conectada a Instagram por ahora" }, 400);
      if (pieza.estado === "publicado") return json({ error: "Esta pieza ya está publicada" }, 400);
      const mediaId = await publicarPieza(admin, pieza, IG_TOKEN, IG_USER);
      return json({ ok: true, publicadas: 1, ig_media_id: mediaId });
    }

    // Modo 2 (cron): publicar las programadas vencidas
    const { data: progs, error: qe } = await admin.from("contenido_piezas")
      .select("*").eq("estado", "programado").eq("cuenta", "ag").not("fecha_pub", "is", null);
    if (qe) return json({ error: qe.message }, 500);
    const now = ahoraMiami();
    const vencidas = (progs || []).filter((p: any) => {
      const f = String(p.fecha_pub); const h = String(p.hora_pub || "00:00").slice(0, 5);
      return f < now.fecha || (f === now.fecha && h <= now.hora);
    });

    const resultados: any[] = []; const errores: any[] = [];
    for (const p of vencidas) {
      try { resultados.push({ pieza: p.id, ig_media_id: await publicarPieza(admin, p, IG_TOKEN, IG_USER) }); }
      catch (e) { errores.push({ pieza: p.id, error: String((e as Error).message) }); }
    }
    return json({ ok: true, publicadas: resultados.length, resultados, errores });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
