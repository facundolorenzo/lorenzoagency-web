// Edge Function: agendar-calendar
// Crea (o actualiza) un evento en Google Calendar cuando se confirma una visita en el panel.
// Usa OAuth con refresh token (del dueño de la agenda) -> access token -> Calendar API.
// Seguridad: solo admin (is_admin) o service_role. Las credenciales viven en secrets.
//
// Secrets que necesita (supabase secrets set ...):
//   GOOGLE_CLIENT_ID       -> client ID del OAuth client (Google Cloud)
//   GOOGLE_CLIENT_SECRET   -> client secret del OAuth client
//   GOOGLE_REFRESH_TOKEN   -> refresh token del dueño del calendario (una sola vez)
//   GCAL_CALENDAR_ID        -> opcional, default "primary"
//   GCAL_TZ                 -> opcional, default "America/New_York"
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

// refresh token -> access token
async function getAccessToken(): Promise<string> {
  const id = Deno.env.get("GOOGLE_CLIENT_ID") || "";
  const secret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
  const refresh = Deno.env.get("GOOGLE_REFRESH_TOKEN") || "";
  if (!id || !secret || !refresh) throw new Error("Faltan las credenciales de Google (GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN).");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error("Google no devolvió token (" + r.status + "): " + txt.slice(0, 200));
  const j = JSON.parse(txt);
  if (!j.access_token) throw new Error("Respuesta sin access_token de Google.");
  return j.access_token as string;
}

// "HH:MM" + "YYYY-MM-DD" + minutos -> "YYYY-MM-DDTHH:MM:SS"
function sumaMin(dia: string, hora: string, min: number): string {
  const [Y, M, D] = dia.split("-").map(Number);
  const [h, m] = hora.split(":").map(Number);
  const d = new Date(Y, (M - 1), D, h, m + min, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
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
    let allowed = (!!SERVICE && token === SERVICE) || jwtRole(token) === "service_role";
    if (!allowed) { const { data: isAdmin } = await supa.rpc("is_admin"); allowed = !!isAdmin; }
    if (!allowed) return json({ error: "No autorizado" }, 403);

    const body = await req.json();
    const {
      id = "", empresa = "", direccion = "", ciudad = "",
      lat = null, lng = null, dia = "", hora = "",
      notas = "", puntoFlojo = "", idioma = "", eventId = "", durMin = 45,
    } = body || {};

    if (!dia || !hora) return json({ error: "Falta día u hora." }, 400);

    const calId = Deno.env.get("GCAL_CALENDAR_ID") || "primary";
    const tz = Deno.env.get("GCAL_TZ") || "America/New_York";
    const access = await getAccessToken();

    const lugar = [direccion, ciudad].filter(Boolean).join(", ");
    const mapsUrl = (lat && lng)
      ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([empresa, ciudad].filter(Boolean).join(", "))}`;
    const desc = [
      "Visita comercial — LORENZO Agency",
      puntoFlojo ? ("Punto flojo: " + puntoFlojo) : "",
      idioma ? ("Idioma: " + idioma) : "",
      notas ? ("Nota: " + notas) : "",
      "Cómo llegar: " + mapsUrl,
    ].filter(Boolean).join("\n");

    const evento = {
      summary: "Visita: " + (empresa || "negocio"),
      location: lugar || undefined,
      description: desc,
      start: { dateTime: sumaMin(dia, hora, 0), timeZone: tz },
      end: { dateTime: sumaMin(dia, hora, durMin), timeZone: tz },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 120 }] },
      source: { title: "LORENZO Agency — Panel", url: "https://lorenzoagency.tech/panel" },
    };

    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
    const url = eventId ? (base + "/" + encodeURIComponent(eventId)) : base;
    const r = await fetch(url, {
      method: eventId ? "PATCH" : "POST",
      headers: { "Authorization": "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify(evento),
    });
    const txt = await r.text();
    if (!r.ok) return json({ error: "Calendar " + r.status + ": " + txt.slice(0, 220) }, 502);
    const ev = JSON.parse(txt);

    // Guardá el eventId en el prospecto para poder editar/borrar después (si hay id + service role)
    if (id && SERVICE) {
      try {
        const admin = createClient(SB_URL, SERVICE);
        await admin.from("prospectos").update({ gcal_event_id: ev.id }).eq("id", id);
      } catch (_e) { /* no romper por esto */ }
    }

    return json({ ok: true, eventId: ev.id, htmlLink: ev.htmlLink });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
