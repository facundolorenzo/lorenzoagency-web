// Checker de respuestas — corre en GitHub Actions (cron).
// Lee el buzón de Private Email por IMAP y detecta quién respondió.
//  - lead que respondió  -> status 'respondio', cuenta respuestas (barra de interés), guarda último texto
//  - lead 'enviado' sin respuesta hace +3 días -> 'sin_respuesta' (seguimiento)
// Usa Supabase REST con la service_role key (secret). No toca el Gmail personal.
import { ImapFlow } from "imapflow";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMAP_USER = process.env.IMAP_USER;   // email completo de la compañía
const IMAP_PASS = process.env.IMAP_PASS;   // contraseña del buzón
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

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT: " + label + " (" + ms + "ms)")), ms))]);

async function main() {
  console.log("1) Leyendo leads en espera desde Supabase...");
  const leads = await rest(
    "leads?select=id,email,status,fecha_primer_envio,respuestas_lead&fecha_primer_envio=not.is.null&status=in.(enviado,sin_respuesta)"
  );
  console.log("   leads en espera:", leads.length);
  if (!leads.length) { console.log("No hay leads en espera de respuesta. Fin."); return; }

  console.log("2) Conectando a IMAP mail.privateemail.com:993 como", IMAP_USER, "...");
  const imap = new ImapFlow({
    host: "mail.privateemail.com", port: 993, secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false, emitLogs: false,
  });
  imap.on("error", (e) => console.error("   IMAP event error:", e && e.message));
  try {
    await withTimeout(imap.connect(), 20000, "conectar/login IMAP — revisá IMAP_PASS o si GitHub alcanza el puerto 993");
  } catch (e) {
    console.error("ERROR DE CONEXIÓN IMAP:", e && e.message);
    throw e;
  }
  console.log("   IMAP conectado OK ✓");

  const lock = await imap.getMailboxLock("INBOX");
  const now = Date.now();
  let detectadas = 0, seguimiento = 0;

  try {
    for (const l of leads) {
      if (!l.email) continue;
      const since = new Date(l.fecha_primer_envio);
      let uids = [];
      try { uids = await imap.search({ from: l.email, since }, { uid: true }); } catch (e) { console.error("   search falló para", l.email, e && e.message); uids = []; }
      const count = Array.isArray(uids) ? uids.length : 0;

      if (count > 0) {
        let snippet = "";
        try {
          const lastUid = uids[uids.length - 1];
          const msg = await imap.fetchOne(lastUid, { bodyParts: ["text"] }, { uid: true });
          const part = msg && msg.bodyParts && msg.bodyParts.get("text");
          if (part) snippet = part.toString("utf8").replace(/\s+/g, " ").slice(0, 500);
        } catch (e) { console.error("   no pude leer el cuerpo de", l.email, e && e.message); }
        await rest("leads?id=eq." + l.id, {
          method: "PATCH",
          body: JSON.stringify({ status: "respondio", respuestas_lead: count, ultima_respuesta_texto: snippet || null }),
        });
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
  } finally {
    lock.release();
    await imap.logout();
  }
  console.log("3) Listo. Respondieron:", detectadas, "· pasaron a seguimiento:", seguimiento);
}

main().catch((e) => { console.error("FALLÓ EL CHECKER:", e && e.message ? e.message : e); process.exit(1); });
