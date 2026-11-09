// MOTOR DE EMPLEO — LORENZO Agency / Cronos
// Lee los perfiles activos del panel (pestaña EMPLEO), busca empresas que contratan con el
// cerebro (claude -p, gratis con tu cuenta), identifica al decisor, redacta el mail y lo carga
// en el panel. Corre solo una vez por día (7 AM) y también cuando tocás "Buscar ahora".
//
// Uso:  node buscador-empleo.mjs            -> una pasada y termina
//       node buscador-empleo.mjs --vigilar  -> queda mirando (corrida diaria + pedidos del panel)
// Necesita: Node 18+, Claude Code (`claude`), y el mismo .env del Agente 4 (SUPABASE_URL,
// SUPABASE_SERVICE_ROLE, opcional APOLLO_API_KEY). Opcional en .env: EMPLEO_HORA=7

import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as dns } from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const execFileP = promisify(execFile);

const DIR = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";

const env = {};
if (existsSync(join(DIR, ".env"))) for (const ln of readFileSync(join(DIR, ".env"), "utf8").split("\n")) { const m = ln.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/); if (m) env[m[1]] = m[2]; }
const URL_B = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE;
if (!URL_B || !KEY) { console.error("Falta .env con SUPABASE_URL y SUPABASE_SERVICE_ROLE (es el mismo .env del Agente 4)"); process.exit(1); }
const APOLLO = env.APOLLO_API_KEY || null;
const HORA = Number(env.EMPLEO_HORA || 7);
const CANTIDAD = Number(env.EMPLEO_CANTIDAD || 12);

const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=representation" };
const api = async (path, opts = {}) => {
  const r = await fetch(URL_B + "/rest/v1/" + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + (await r.text()).slice(0, 300));
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
const patchPerfil = (id, body) => api("perfiles_empleo?id=eq." + id, { method: "PATCH", body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) }).catch(e => console.error("  (no pude actualizar el perfil: " + String(e.message).slice(0, 120) + ")"));

const PROMPT_BASE = readFileSync(join(DIR, "PROMPT-EMPLEO.md"), "utf8");
const limpio = v => (v == null ? null : (String(v).trim() || null));

const mxCache = new Map();
async function emailVivo(email) {
  const d = (String(email || "").split("@")[1] || "").toLowerCase();
  if (!d || !d.includes(".")) return false;
  if (mxCache.has(d)) return mxCache.get(d);
  let ok = false; try { const mx = await dns.resolveMx(d); ok = Array.isArray(mx) && mx.length > 0; } catch {}
  mxCache.set(d, ok); return ok;
}

// Apollo People Match: email verificado del decisor (1 crédito solo si lo encuentra)
async function apolloMatch(nombre, empresa, web) {
  if (!APOLLO) return null;
  let dominio; try { dominio = new URL(String(web || "").startsWith("http") ? web : "https://" + web).hostname.replace(/^www\./, ""); } catch {}
  try {
    const r = await fetch("https://api.apollo.io/api/v1/people/match", { method: "POST", headers: { "x-api-key": APOLLO, "Content-Type": "application/json", accept: "application/json" }, body: JSON.stringify({ name: nombre, organization_name: empresa, domain: dominio }) });
    if (!r.ok) return null;
    const j = await r.json(); const p = j && j.person;
    if (p && p.email && p.email_status === "verified") return p.email;
  } catch {}
  return null;
}

async function aprendizaje(perfilId) {
  try {
    const no = await api(`empleos?perfil_id=eq.${perfilId}&feedback=eq.no&select=empresa,rol,etapa&order=updated_at.desc&limit=20`);
    const ok = await api(`empleos?perfil_id=eq.${perfilId}&or=(feedback.eq.ok,status.eq.respondio)&select=empresa,rol,etapa&order=updated_at.desc&limit=20`);
    const li = x => "- " + x.empresa + (x.rol ? " (" + x.rol + (x.etapa ? ", " + x.etapa : "") + ")" : "");
    const p = ["\n## APRENDIZAJE DEL DUEÑO (feedback real; pesa más que cualquier regla)"];
    if (no && no.length) p.push("Marcó como NO SIRVEN:\n" + no.map(li).join("\n"));
    if (ok && ok.length) p.push("Marcó como SÍ SIRVEN o le respondieron:\n" + ok.map(li).join("\n"));
    return p.length > 1 ? p.join("\n") : "";
  } catch { return ""; }
}

async function cerebro(perfil, yaTengo) {
  const vars = [
    "## PERFIL",
    "NOMBRE: " + perfil.nombre,
    "ROLES QUE BUSCA: " + (perfil.roles || "(no definido)"),
    "PAÍS: " + (perfil.pais || "Estados Unidos") + " · UBICACIÓN/MODALIDAD: " + (perfil.ubicacion || "cualquiera"),
    "SALARIO MÍNIMO: " + (perfil.salario_min ? "$" + perfil.salario_min + "k/año" : "(sin mínimo)"),
    "ETAPAS DE EMPRESA: " + (perfil.etapas || "cualquiera"),
    "CONTRATO: " + (perfil.contrato || "cualquiera"),
    "EXPERIENCIA: " + (perfil.experiencia || "(no cargada)"),
    "LO QUE LO HACE DISTINTO: " + (perfil.distinto || ""),
    "PROYECTOS: " + (perfil.proyectos || ""),
    perfil.linkedin ? "LINKEDIN: " + perfil.linkedin : "",
    "\n## MAIL BASE (respetá estructura y tono; completá {nombre} {empresa} {rol} {gancho})",
    "ASUNTO BASE: " + (perfil.mail_asunto || "(vacío)"),
    perfil.mail_base || "(vacío: escribí uno corto según las reglas)",
    "\n## CANTIDAD: traé hasta " + CANTIDAD + " empresas nuevas",
    "FECHA DE HOY: " + new Date().toISOString().slice(0, 10),
    await aprendizaje(perfil.id),
    "\n## YA ENCONTRADAS (no repetir):\n" + (yaTengo.length ? yaTengo.map(x => "- " + x).join("\n") : "(ninguna)"),
  ].filter(Boolean).join("\n");
  let out = "";
  try {
    const child = execFileP("claude", ["-p", "--dangerously-skip-permissions"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 50, timeout: 1000 * 60 * 50, shell: WIN });
    child.child.stdin.end(PROMPT_BASE + "\n\n" + vars);
    out = (await child).stdout || "";
  } catch (e) { console.error("  El cerebro falló: " + String(e.message).slice(0, 300)); return null; }
  const m = out.match(/<EMPRESAS>([\s\S]*?)<\/EMPRESAS>/);
  if (!m) { console.error("  Salida sin bloque <EMPRESAS>. Final:\n" + out.slice(-400)); return null; }
  try { const rows = JSON.parse(m[1]); return Array.isArray(rows) ? rows : []; } catch { console.error("  JSON inválido."); return null; }
}

async function correr(perfil, motivo) {
  console.log(`\n[${new Date().toLocaleTimeString()}] Buscando para ${perfil.nombre} (${motivo})…`);
  await patchPerfil(perfil.id, { estado_motor: "buscando", pedido_busqueda: false });
  const existentes = (await api(`empleos?perfil_id=eq.${perfil.id}&select=empresa`)) || [];
  const ya = new Set(existentes.map(x => String(x.empresa).toLowerCase().trim()));
  const rows = await cerebro(perfil, [...ya]);
  if (!rows) { await patchPerfil(perfil.id, { estado_motor: "error", ultima_corrida: new Date().toISOString() }); return; }
  const nuevos = [];
  for (const r of rows) {
    const emp = limpio(r.empresa); if (!emp || ya.has(emp.toLowerCase())) continue;
    let email = limpio(r.decisor_email), verif = !!r.decisor_email_verificado, nota = limpio(r.notas), apEst = null;
    if (email && /^(jobs|careers|hello|info|contact|hr|talent|team)@/i.test(email)) { nota = [nota, "email genérico: " + email].filter(Boolean).join(" · "); email = null; verif = false; }
    if (email && !(await emailVivo(email))) { nota = [nota, "dominio sin correo, descartado: " + email].filter(Boolean).join(" · "); email = null; verif = false; }
    // Apollo solo para los candidatos fuertes sin email (cuida los créditos)
    if (!email && APOLLO && limpio(r.decisor_nombre) && Number(r.match) >= 60) {
      const ap = await apolloMatch(r.decisor_nombre, emp, r.web);
      if (ap && (await emailVivo(ap))) { email = ap; verif = true; apEst = "hecho"; nota = [nota, "Apollo encontró el email del decisor"].filter(Boolean).join(" · "); console.log("  ⭐ Apollo: " + r.decisor_nombre + " @ " + emp); }
      else apEst = "sin_resultado";
    }
    ya.add(emp.toLowerCase());
    nuevos.push({
      perfil_id: perfil.id, empresa: emp, web: limpio(r.web), ciudad: limpio(r.ciudad), tamano: limpio(r.tamano), etapa: limpio(r.etapa),
      rol: limpio(r.rol), salario: limpio(r.salario), modalidad: limpio(r.modalidad), fuente: limpio(r.fuente), url_aviso: limpio(r.url_aviso),
      publicado: limpio(r.publicado), senal: limpio(r.senal), descripcion: limpio(r.descripcion),
      decisor_nombre: limpio(r.decisor_nombre), decisor_cargo: limpio(r.decisor_cargo), decisor_email: email, decisor_email_verificado: verif, decisor_linkedin: limpio(r.decisor_linkedin),
      match: Number.isFinite(Number(r.match)) ? Math.max(0, Math.min(100, Math.round(Number(r.match)))) : null,
      por_que: limpio(r.por_que), mail_asunto: limpio(r.mail_asunto), mail_cuerpo: limpio(r.mail_cuerpo),
      status: "nuevo", apollo_estado: apEst, apollo_nota: apEst === "sin_resultado" ? "Apollo no encontró email verificado" : null, notas: nota,
      created_at: new Date().toISOString(),
    });
  }
  if (nuevos.length) await api("empleos", { method: "POST", body: JSON.stringify(nuevos) });
  await patchPerfil(perfil.id, { estado_motor: "lista", ultima_corrida: new Date().toISOString(), ultima_revisadas: rows.length, ultima_nuevas: nuevos.length });
  console.log(`  Listo: ${rows.length} revisadas, ${nuevos.length} nuevas cargadas en el panel (EMPLEO → Para hoy).`);
}

// Pedidos sueltos de Apollo desde el panel ("⚡ Buscar email")
async function refuerzosApollo() {
  if (!APOLLO) return;
  const pend = (await api("empleos?apollo_estado=eq.pendiente&select=id,empresa,web,decisor_nombre")) || [];
  for (const e of pend) {
    if (!e.decisor_nombre) { await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ apollo_estado: "sin_resultado", apollo_nota: "No hay nombre del decisor para buscar" }) }); continue; }
    const ap = await apolloMatch(e.decisor_nombre, e.empresa, e.web);
    const ok = ap && (await emailVivo(ap));
    await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify(ok ? { decisor_email: ap, decisor_email_verificado: true, apollo_estado: "hecho", apollo_nota: "Apollo encontró el email verificado", updated_at: new Date().toISOString() } : { apollo_estado: "sin_resultado", apollo_nota: "Apollo no encontró un email verificado de " + e.decisor_nombre, updated_at: new Date().toISOString() }) });
    console.log((ok ? "  ⭐ Apollo encontró: " : "  Apollo sin resultado: ") + e.decisor_nombre + " @ " + e.empresa);
  }
}

const hoyKey = () => new Date().toISOString().slice(0, 10);
function tocaHoy(p) {
  if (p.pedido_busqueda) return "pedido desde el panel";
  if (p.estado_motor === "buscando") return null;
  const h = new Date().getHours();
  if (h < HORA) return null;
  if (!p.ultima_corrida) return "primera corrida";
  if (String(p.ultima_corrida).slice(0, 10) !== hoyKey()) return "corrida diaria";
  return null;
}
async function tick() {
  await refuerzosApollo();
  const perfiles = (await api("perfiles_empleo?activo=eq.true&select=*")) || [];
  for (const p of perfiles) { const m = tocaHoy(p); if (m) await correr(p, m); }
}

const VIGILAR = process.argv.includes("--vigilar");
console.log("MOTOR DE EMPLEO" + (APOLLO ? " · Apollo conectado" : " · sin Apollo") + " · corrida diaria a las " + HORA + ":00 · hasta " + CANTIDAD + " empresas por corrida");
if (!VIGILAR) {
  const perfiles = (await api("perfiles_empleo?activo=eq.true&select=*")) || [];
  if (!perfiles.length) console.log("No hay perfiles activos. Creá uno en el panel (EMPLEO → Perfiles).");
  await refuerzosApollo();
  for (const p of perfiles) await correr(p, "pasada manual");
} else {
  console.log("Modo vigilancia: dejá esta ventana abierta. Reviso el panel cada 30s (pedidos de 'Buscar ahora' y la corrida diaria).");
  for (;;) { try { await tick(); } catch (e) { console.error("Error: " + String(e.message).slice(0, 200)); } await new Promise(r => setTimeout(r, 30000)); }
}
