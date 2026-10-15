// Checker — corre en GitHub Actions (cron). Dos trabajos:
//  1) Lee el buzón de Private Email (IMAP) y detecta quién respondió:
//     - mueve el lead a 'respondio', cuenta respuestas (barra de interés),
//       guarda el texto de la respuesta y redacta un borrador de contestación.
//     - lead 'enviado' sin respuesta hace +N días -> 'sin_respuesta'.
//  2) Para cada lead NUEVO del sitio sin borrador, redacta el primer borrador.
// Redacta llamando a la Edge Function `sugerir` (ahí vive el cerebro + la API key).
import { ImapFlow } from "imapflow";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const DIAS_SIN_RESPUESTA = Number(process.env.DIAS_SIN_RESPUESTA || 3);

for (const [k, v] of Object.entries({ SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY, IMAP_USER, IMAP_PASS })) {
  if (!v) { console.error("Falta la variable:", k); process.exit(1); }
}

const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
async function rest(path, opts = {}) {
  const res = await fetch(SB_URL + "/rest/v1/" + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const txt = await res.text();
  if (!res.ok) throw new Error("SUPABASE " + path + " -> " + res.status + " " + txt);
  return txt ? JSON.parse(txt) : null;
}

// Pide al agente un borrador de respuesta (usa la service_role key para autorizarse)
async function draft(lead, message) {
  try {
    const res = await fetch(SB_URL + "/functions/v1/sugerir", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + SB_KEY, apikey: SB_KEY },
      body: JSON.stringify({ message: message || "", name: lead.name || "", service: lead.service || "" }),
    });
    if (!res.ok) { console.error("   sugerir ->", res.status, (await res.text()).slice(0, 140)); return null; }
    const j = await res.json();
    return j.reply || null;
  } catch (e) { console.error("   draft falló:", e && e.message); return null; }
}

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT: " + label + " (" + ms + "ms)")), ms))]);

// Detección de idioma (ES/EN) — misma heurística que el panel. Facu puede corregir el chip.
function detectLang(txt) {
  const t = " " + String(txt || "").toLowerCase() + " ";
  if (!t.trim()) return "es";
  let es = 0, en = 0;
  if (/[ñáéíóúü¿¡]/.test(t)) es += 3;
  const ES = [" que ", " los ", " las ", " una ", " para ", " con ", " por ", " pero ", " como ", " tengo ", " quiero ", " hola ", " gracias ", " cuánto ", " cuanto ", " precio ", " necesito ", " hacer ", " están ", " estan ", " muy ", " más ", " mas ", " también ", " tambien ", " cómo ", " buenas ", " saludos "];
  const EN = [" the ", " you ", " your ", " and ", " for ", " with ", " have ", " want ", " hello ", " hi ", " thanks ", " thank ", " how ", " much ", " price ", " need ", " would ", " could ", " please ", " we ", " our ", " about ", " looking ", " interested "];
  for (const w of ES) if (t.includes(w)) es++;
  for (const w of EN) if (t.includes(w)) en++;
  return es >= en ? "es" : "en";
}

async function main() {
  // ===== Trabajo 2 (sin IMAP): borrador para leads nuevos del sitio =====
  console.log("A) Leads nuevos sin borrador...");
  const nuevos = await rest("leads?select=id,name,service,message,status,borrador&status=eq.nuevo&borrador=is.null");
  console.log("   nuevos sin borrador:", nuevos.length);
  for (const l of nuevos) {
    const texto = await draft(l, l.message);
    if (texto) { await rest("leads?id=eq." + l.id, { method: "PATCH", body: JSON.stringify({ borrador: texto }) }); console.log("   ✎ borrador listo:", l.email || l.name || l.id); }
  }

  // ===== Trabajo 1 (IMAP): detectar respuestas =====
  console.log("B) Leads esperando respuesta...");
  const leads = await rest(
    "leads?select=id,name,email,service,message,status,fecha_primer_envio,respuestas_lead&fecha_primer_envio=not.is.null&status=in.(enviado,sin_respuesta)"
  );
  console.log("   en espera:", leads.length, "(igual conecto IMAP para capturar entrantes nuevos)");

  console.log("   Conectando IMAP mail.privateemail.com:993 como", IMAP_USER, "...");
  const imap = new ImapFlow({ host: "mail.privateemail.com", port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false, emitLogs: false });
  imap.on("error", (e) => console.error("   IMAP event error:", e && e.message));
  try { await withTimeout(imap.connect(), 20000, "conectar/login IMAP (revisá IMAP_PASS)"); }
  catch (e) { console.error("ERROR DE CONEXIÓN IMAP:", e && e.message); throw e; }
  console.log("   IMAP conectado OK ✓");

  const lock = await imap.getMailboxLock("INBOX");
  const now = Date.now();
  let detectadas = 0, seguimiento = 0;
  try {
    for (const l of leads) {
      if (!l.email) continue;
      const since = new Date(l.fecha_primer_envio);
      let uids = [];
      try { uids = await imap.search({ from: l.email, since }, { uid: true }); } catch (e) { console.error("   search", l.email, e && e.message); uids = []; }
      const count = Array.isArray(uids) ? uids.length : 0;
      const prev = Number(l.respuestas_lead) || 0;

      if (count > 0) {
        // leer el texto de la última respuesta
        let texto = "";
        try {
          const msg = await imap.fetchOne(uids[uids.length - 1], { bodyParts: ["text"] }, { uid: true });
          const part = msg && msg.bodyParts && msg.bodyParts.get("text");
          if (part) texto = part.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 1500);
        } catch (e) { console.error("   body", l.email, e && e.message); }

        const patch = { status: "respondio", respuestas_lead: count };
        if (texto) patch.ultima_respuesta_texto = texto;
        // si es una respuesta NUEVA (subió el contador), redacto un borrador de contestación
        if (count !== prev) {
          const b = await draft(l, texto || l.message);
          if (b) patch.borrador = b;
        }
        await rest("leads?id=eq." + l.id, { method: "PATCH", body: JSON.stringify(patch) });
        detectadas++;
        console.log("   ✓ respondió:", l.email, "(" + count + ")");
      } else if (l.status === "enviado") {
        const dias = (now - since.getTime()) / 86400000;
        if (dias >= DIAS_SIN_RESPUESTA) {
          await rest("leads?id=eq." + l.id, { method: "PATCH", body: JSON.stringify({ status: "sin_respuesta" }) });
          seguimiento++;
          console.log("   · sin respuesta (" + Math.floor(dias) + "d):", l.email);
        }
      }
    }
    // ===== Trabajo 3 (IMAP): emails nuevos a la empresa -> leads =====
    console.log("C) Emails nuevos entrantes -> leads...");
    const INBOUND_DIAS = Number(process.env.INBOUND_DIAS || 2);
    const since3 = new Date(now - INBOUND_DIAS * 86400000);
    const allLeads = await rest("leads?select=email");
    const known = new Set((allLeads || []).map((x) => (x.email || "").toLowerCase()).filter(Boolean));
    known.add((IMAP_USER || "").toLowerCase());
    const SKIP = /(no-?reply|noreply|mailer-daemon|postmaster|donotreply|do-not-reply|notifications?@|bounce|@.*(mailchimp|sendgrid|amazonses|substack))/i;

    // 1) recolectar remitentes candidatos (solo envelope, liviano)
    const byAddr = new Map();
    try {
      for await (const msg of imap.fetch({ since: since3 }, { uid: true, envelope: true })) {
        const env = msg.envelope || {};
        const fromObj = (env.from && env.from[0]) || {};
        const addr = (fromObj.address || "").toLowerCase();
        if (!addr || known.has(addr) || SKIP.test(addr)) continue;
        byAddr.set(addr, { uid: msg.uid, addr, name: fromObj.name || "", subject: env.subject || "" });
      }
    } catch (e) { console.error("   fetch entrantes:", e && e.message); }

    // 2) crear un lead por remitente nuevo (con borrador listo)
    let nuevosMail = 0;
    for (const c of byAddr.values()) {
      if (nuevosMail >= 40) { console.log("   corte de seguridad: 40 por corrida"); break; }
      let texto = "";
      try {
        const m = await imap.fetchOne(c.uid, { bodyParts: ["text"] }, { uid: true });
        const part = m && m.bodyParts && m.bodyParts.get("text");
        if (part) texto = part.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 1500);
      } catch (e) { /* sin cuerpo, uso solo el asunto */ }
      const mensaje = (c.subject ? c.subject + "\n\n" : "") + texto;
      const row = { name: c.name || c.addr, email: c.addr, message: mensaje, status: "nuevo", idioma: detectLang(mensaje), created_at: new Date().toISOString() };
      let created = null;
      try { created = await rest("leads", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }); }
      catch (e) { console.error("   insert lead", c.addr, e && e.message); continue; }
      nuevosMail++; known.add(c.addr);
      const lead = Array.isArray(created) ? created[0] : created;
      try { const b = await draft({ name: row.name, service: "", message: mensaje }, mensaje); if (b && lead && lead.id) await rest("leads?id=eq." + lead.id, { method: "PATCH", body: JSON.stringify({ borrador: b }) }); } catch (e) {}
      console.log("   + lead nuevo desde email:", c.addr);
    }
    console.log("   leads nuevos desde email:", nuevosMail);
  } finally { lock.release(); await imap.logout(); }
  console.log("Listo. Respondieron:", detectadas, "· a seguimiento:", seguimiento);
}

main().catch((e) => { console.error("FALLÓ EL CHECKER:", e && e.message ? e.message : e); process.exit(1); });
