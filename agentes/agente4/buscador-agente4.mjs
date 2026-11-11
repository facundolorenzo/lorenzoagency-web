// AGENTE 4 — Trabajador buscador de LORENZO Agency (V3: carga por tandas + % de avance)
// 1) DESCUBRE con google-maps-scraper (MIT, gratis) si está instalado al lado
// 2) El agente (claude -p) JUZGA por tandas de 20: filtra, señales de plata, prioridad A/B/C
// 3) Carga cada tanda apenas está lista (los negocios van apareciendo en el panel)
// 4) Reporta % de avance en la búsqueda — el panel lo muestra en vivo
// Si el scraper no está, el agente busca solo (fallback, más lento).
//
// Modos de búsqueda (columna busquedas.modo):
//   "nicho"       -> traé varios negocios del rubro en la zona (lo normal)
//   "especifico"  -> fichar UN lugar puntual por su nombre (ej: "Mica, Coral Gables")
//
// Uso:  node buscador-agente4.mjs
// Necesita: Node 18+, Claude Code (`claude`), y un .env al lado con:
//   SUPABASE_URL=https://noxvfulftytfizzaunln.supabase.co
//   SUPABASE_SERVICE_ROLE=...   (secreto — nunca compartirlo)
// Opcional (recomendado): el binario google-maps-scraper(.exe) en esta misma carpeta
//   -> https://github.com/gosom/google-maps-scraper/releases

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import { promises as dns } from "node:dns";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";

// ---- .env ----
const env = {};
if (existsSync(join(DIR, ".env"))) {
  for (const ln of readFileSync(join(DIR, ".env"), "utf8").split("\n")) {
    const m = ln.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const URL_B = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE;
if (!URL_B || !KEY) { console.error("Falta .env con SUPABASE_URL y SUPABASE_SERVICE_ROLE"); process.exit(1); }

const APOLLO = env.APOLLO_API_KEY || null;   // opcional: emails directos del dueño (plan free)

const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const api = async (path, opts = {}) => {
  const r = await fetch(URL_B + "/rest/v1/" + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + (await r.text()).slice(0, 300));
  if (r.status === 204) return null;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
};
const marcar = (id, status, extra = {}) =>
  api("busquedas?id=eq." + id, { method: "PATCH", body: JSON.stringify({ status, ...extra, updated_at: new Date().toISOString() }) })
    .catch(e => console.error("  (no pude actualizar la búsqueda: " + String(e.message).slice(0, 120) + ")"));

const PROMPT_BASE = readFileSync(join(DIR, "PROMPT-AGENTE4.md"), "utf8");

// APRENDIZAJE DEL DUEÑO: lee los ✓/✗ que Facu marcó en el panel y se los pasa al agente
// como ejemplos reales — su criterio pesa más que cualquier regla escrita.
async function aprendizajeDuenio() {
  try {
    const no = await api("prospectos?feedback=eq.no&select=empresa,nicho,ciudad,feedback_motivo&order=created_at.desc&limit=30");
    const ok = await api("prospectos?feedback=eq.ok&select=empresa,nicho,ciudad,prioridad_motivo&order=created_at.desc&limit=20");
    if ((!no || !no.length) && (!ok || !ok.length)) return "";
    const linea = x => "- " + x.empresa + (x.nicho ? " (" + x.nicho + (x.ciudad ? ", " + x.ciudad : "") + ")" : "");
    const partes = ["\n## APRENDIZAJE DEL DUEÑO (feedback real sobre búsquedas anteriores — pesa más que cualquier otra regla)"];
    if (no && no.length) partes.push("El dueño marcó estos como NO SIRVEN — descartá negocios de este estilo:\n" + no.map(x => linea(x) + (x.feedback_motivo ? " — motivo: " + x.feedback_motivo : "")).join("\n"));
    if (ok && ok.length) partes.push("El dueño marcó estos como SÍ SIRVEN — priorizá negocios de este estilo:\n" + ok.map(linea).join("\n"));
    return partes.join("\n");
  } catch { return ""; }
}

// ---- scraper (si está) ----
const SCRAPER = ["google-maps-scraper.exe", "google-maps-scraper"].map(n => join(DIR, n)).find(existsSync) || null;
console.log(SCRAPER ? "Scraper encontrado: descubrimiento con Google Maps (MIT)." : "Sin scraper al lado — el agente buscará solo (más lento). Recomendado: bajá el binario de github.com/gosom/google-maps-scraper/releases");
console.log(APOLLO ? "Apollo conectado: busca el email directo del dueño SOLO en búsquedas de lugar puntual 📍 (cuida los 75 créditos gratis del mes)." : "Sin Apollo (opcional): agregá APOLLO_API_KEY al .env para completar emails directos en búsquedas puntuales.");

const pick = (o, ...keys) => { for (const k of keys) { if (o[k] != null && String(o[k]).trim()) return String(o[k]).trim(); } return ""; };

// Verificación de emails (paso final del waterfall): el dominio tiene que existir y recibir correo (MX)
const mxCache = new Map();
async function emailVivo(email) {
  const d = (String(email).split("@")[1] || "").toLowerCase().trim();
  if (!d || !d.includes(".")) return false;
  if (mxCache.has(d)) return mxCache.get(d);
  let ok = false;
  try { const mx = await dns.resolveMx(d); ok = Array.isArray(mx) && mx.length > 0; } catch { ok = false; }
  mxCache.set(d, ok);
  return ok;
}

// Apollo People Enrichment (plan free): SOLO en búsquedas de LUGAR PUNTUAL (si Facu la pidió
// a mano es que le interesa de verdad) con persona identificada y sin email directo.
// Cuesta 1 crédito si devuelve email (75/mes en el plan free) — por eso el tope.
const APOLLO_MAX = 10;
let apolloUsados = 0;
async function apolloMatch(nombre, empresa, web) {
  let dominio; try { dominio = new URL(String(web || "").startsWith("http") ? web : "https://" + web).hostname.replace(/^www\./, ""); } catch {}
  try {
    const r = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: { "x-api-key": APOLLO, "Content-Type": "application/json", accept: "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ name: nombre, organization_name: empresa, domain: dominio }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const per = j && j.person;
    if (per && per.email && per.email_status === "verified") return per.email;
  } catch {}
  return null;
}

// People Search: pregunta QUIÉN trabaja en la empresa (dueño/GM/marketing) — no gasta créditos
// porque no revela emails. Si el plan free no lo permite, se apaga solo y no afecta nada.
let APOLLO_SEARCH_OK = true;
async function apolloQuienes(empresa, web) {
  if (!APOLLO || !APOLLO_SEARCH_OK) return [];
  let dominio; try { dominio = new URL(String(web || "").startsWith("http") ? web : "https://" + web).hostname.replace(/^www\./, ""); } catch {}
  if (!dominio) return [];
  try {
    const r = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
      method: "POST",
      headers: { "x-api-key": APOLLO, "Content-Type": "application/json", accept: "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ q_organization_domains_list: [dominio], person_titles: ["owner","founder","co-founder","ceo","general manager","manager","marketing manager","marketing director","director of marketing","events manager"], per_page: 5 }),
    });
    if (r.status === 402 || r.status === 403) { APOLLO_SEARCH_OK = false; console.log("  ⚡ People Search de Apollo no entra en tu plan — sigo sin eso (lo demás no cambia)."); return []; }
    if (!r.ok) return [];
    const j = await r.json();
    return (j.people || []).map(x => ({ nombre: [x.first_name, x.last_name].filter(Boolean).join(" ").trim(), cargo: x.title || "" })).filter(x => x.nombre.includes(" "));
  } catch { return []; }
}
async function apolloEmail(contacto, empresa, web) {
  if (!APOLLO || apolloUsados >= APOLLO_MAX) return null;
  const nombre = String(contacto).split(/[—(,]|\s-\s/)[0].trim();
  if (!nombre || !nombre.includes(" ")) return null;        // necesita nombre y apellido
  const em = await apolloMatch(nombre, empresa, web);
  if (em) apolloUsados++;
  return em;
}

// Hunter.io (plan free: 25 búsquedas/mes): encuentra el email por el DOMINIO de la web.
// Complementa a Apollo: Hunter rinde cuando hay web, Apollo cuando hay persona.
const HUNTER = env.HUNTER_API_KEY || null;
const HUNTER_MAX = 6;            // tope por corrida para cuidar el cupo del mes
let hunterUsados = 0;
function _dominioDe(web) { try { return new URL(String(web || "").startsWith("http") ? web : "https://" + web).hostname.replace(/^www\./, ""); } catch { return null; } }
async function hunterEmail(contacto, web) {
  if (!HUNTER || hunterUsados >= HUNTER_MAX) return null;
  const dominio = _dominioDe(web); if (!dominio) return null;
  const nombre = String(contacto || "").split(/[—(,]|\s-\s/)[0].trim();
  try {
    if (nombre && nombre.includes(" ")) {
      const [fn, ...resto] = nombre.split(/\s+/);
      const r = await fetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(dominio)}&first_name=${encodeURIComponent(fn)}&last_name=${encodeURIComponent(resto.join(" "))}&api_key=${HUNTER}`);
      if (r.ok) { hunterUsados++; const d = ((await r.json()) || {}).data; if (d && d.email && (d.score || 0) >= 80) return d.email; }
      else if (r.status === 402 || r.status === 429) return null;
    }
    const r2 = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(dominio)}&limit=10&api_key=${HUNTER}`);
    if (!r2.ok) return null;
    hunterUsados++;
    const ems = ((((await r2.json()) || {}).data) || {}).emails || [];
    const per = ems.filter(e => e.type === "personal" && (e.confidence || 0) >= 80).sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    return per ? per.value : null;
  } catch { return null; }
}

function parsearResultados(outFile) {
  if (!existsSync(outFile)) return [];
  const lineas = readFileSync(outFile, "utf8").split("\n").filter(x => x.trim());
  const items = [];
  for (const ln of lineas) { try { items.push(JSON.parse(ln)); } catch {} }
  // normalizar campos (tolerante a nombres distintos entre versiones)
  return items.map(r => ({
    empresa: pick(r, "title", "name"),
    phone: pick(r, "phone", "phone_number"),
    web: pick(r, "website", "web_site", "link"),
    emails: Array.isArray(r.emails) ? r.emails.filter(Boolean).join(", ") : pick(r, "emails", "email"),
    direccion: pick(r, "address", "complete_address", "formatted_address"),
    categoria: pick(r, "category", "categories", "main_category"),
    rating: pick(r, "review_rating", "rating"),
    resenas: (() => { const rv = r.user_reviews || r.reviews; if (!Array.isArray(rv)) return [];
      return rv.slice(0, 5).map(x => typeof x === "string" ? x : ((x && (x.description || x.text || x.snippet)) || "")).filter(Boolean); })(),
  })).filter(x => x.empresa);
}

// Corre el scraper y, mientras tanto, va subiendo el % según lo que va encontrando
function correrScraper(b, onProgreso) {
  const esp = b.modo === "especifico";
  const zonaLimpia = (b.zona || "").replace(/\d+\s*millas alrededor de\s*/i, "").trim();
  // Lugar puntual: nombre exacto (+ ciudad). Nicho: "rubro near zona".
  const q = esp
    ? (b.rubro + (zonaLimpia ? ", " + zonaLimpia : "")).trim()
    : b.rubro + " near " + (zonaLimpia || "Miami, FL");
  const qFile = join(DIR, "_query-" + b.id + ".txt"), outFile = join(DIR, "_results-" + b.id + ".json");
  writeFileSync(qFile, q + "\n");
  try { rmSync(outFile, { force: true }); } catch {}
  const args = ["-input", qFile, "-results", outFile, "-json", "-email", "-c", "6", "-exit-on-inactivity", esp ? "30s" : "90s", "-zoom", esp ? "15" : "14", "-lang", "en"];
  if (b.radio_millas && !esp) { args.push("-radius", String(Math.round(b.radio_millas * 1609))); }
  console.log("  Scrapeando Google Maps: \"" + q + "\"" + (esp ? " (lugar puntual)" : " (esto tarda varios minutos)") + "...");
  return new Promise(res => {
    const t = setInterval(() => {
      try {
        const n = readFileSync(outFile, "utf8").split("\n").filter(x => x.trim()).length;
        onProgreso(Math.min(38, 10 + Math.round(n / 4)));
      } catch {}
    }, 25000);
    execFile(SCRAPER, args, { timeout: 1000 * 60 * 40 }, (e) => {
      clearInterval(t);
      if (e) console.error("  Scraper terminó con aviso: " + String(e.message).slice(0, 160));
      const r = parsearResultados(outFile);
      try { rmSync(qFile, { force: true }); rmSync(outFile, { force: true }); } catch {}
      res(r);
    });
  });
}

// Pide al agente que juzgue una tanda y devuelve las filas parseadas (null = falló)
async function juzgar(b, listaTxt, nota, aprendizaje) {
  const esp = b.modo === "especifico";
  const vars = [
    esp ? "MODO: LUGAR ESPECÍFICO — la lista de abajo es UN negocio puntual que el usuario quiere fichar por su nombre. NO filtres por rubro ni lo descartes: identificá el que mejor coincide con el nombre pedido, extraé TODA su info y armá su ficha completa (incluida la ENTRADA DE VENTA). Devolvé SOLO ese negocio." : "",
    (esp ? "NOMBRE DEL LUGAR: " : "RUBRO: ") + b.rubro,
    "ZONA: " + (b.zona || "Miami, FL"),
    b.lat && b.lng ? "CENTRO: " + b.lat + ", " + b.lng + " · RADIO: " + (b.radio_millas || 10) + " millas" : "",
    esp ? "" : "TIPO DE EMPRESA: " + (b.target || "ambas"),
    esp ? "" : "DETALLES EXTRA: " + (b.detalles || "(ninguno)"),
    aprendizaje || "",
    "FECHA DE HOY: " + new Date().toISOString().slice(0, 10),
    nota,
    "\nLISTA DE NEGOCIOS DEL SCRAPER:\n" + listaTxt,
  ].filter(Boolean).join("\n");
  // El prompt entra por stdin. execFile async -> varias tandas pueden correr en paralelo.
  let out = "";
  try {
    const child = execFileP("claude", ["-p", "--dangerously-skip-permissions"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 50, timeout: 1000 * 60 * 45, shell: WIN });
    child.child.stdin.end(PROMPT_BASE + "\n\n## PARÁMETROS DE ESTA BÚSQUEDA\n" + vars);
    const res = await child;
    out = res.stdout || "";
  } catch (e) { console.error("  El agente falló en esta tanda: " + String(e.message).slice(0, 300)); return null; }
  const m = out.match(/<NEGOCIOS>([\s\S]*?)<\/NEGOCIOS>/);
  if (!m) { console.error("  Tanda sin bloque parseable. Última salida:\n" + out.slice(-400)); return null; }
  try { const rows = JSON.parse(m[1]); return Array.isArray(rows) ? rows : []; } catch { console.error("  JSON inválido en la tanda."); return null; }
}

// Verifica emails y arma las filas listas para insertar
async function prepararFilas(rows, b, titulo, existentes) {
  const limpio = v => (v && String(v).trim()) || null;
  const nuevos = [];
  for (const r of rows) {
    const emp = limpio(r.empresa); if (!emp) continue;
    if (existentes.has(emp.toLowerCase())) { console.log("  (ya estaba) " + emp); continue; }
    let em1 = limpio(r.email), em2 = limpio(r.email_directo), viaNota = null;
    if (em1 && !(await emailVivo(em1))) { console.log("  (email con dominio muerto, descartado) " + em1); em1 = null; }
    if (em2 && !(await emailVivo(em2))) { console.log("  (email con dominio muerto, descartado) " + em2); em2 = null; }
    if (!em2 && (b.modo === "especifico" || r.prioridad === "A")) {
      // Cascada automática de email directo: 1º Hunter (por la web) → 2º Apollo (por la persona)
      const hu = await hunterEmail(r.contacto, limpio(r.web));
      if (hu && (await emailVivo(hu))) { em2 = hu; viaNota = "Hunter encontró el email directo: " + hu; console.log("  ⭐ Hunter encontró el directo (" + emp + "): " + hu); }
      if (!em2 && limpio(r.contacto)) {
        const ap = await apolloEmail(r.contacto, emp, limpio(r.web));
        if (ap && (await emailVivo(ap))) { em2 = ap; viaNota = "Apollo agregó el email directo: " + ap; console.log("  ⭐ Apollo encontró el directo de " + r.contacto + " (" + emp + ")"); }
      }
    }
    if (!(em1 || em2 || limpio(r.phone) || limpio(r.phone_directo))) continue;
    existentes.add(emp.toLowerCase());
    nuevos.push({
      empresa: emp,
      contacto: limpio(r.contacto), email: em1, email_directo: em2,
      phone: limpio(r.phone), phone_directo: limpio(r.phone_directo),
      web: limpio(r.web), instagram: limpio(r.instagram),
      nicho: limpio(r.nicho) || b.rubro, ciudad: limpio(r.ciudad),
      fuente: limpio(r.fuente) || (SCRAPER ? "Google Maps" : "agente"),
      busqueda: titulo,
      prioridad: ["A", "B", "C"].includes(r.prioridad) ? r.prioridad : null,
      prioridad_motivo: limpio(r.prioridad_motivo),
      punto_flojo: limpio(r.punto_flojo),
      entrada: limpio(r.entrada),
      status: (em1 || em2) ? "contactable" : "encontrado",
      ...(viaNota ? { apollo_estado: "hecho", apollo_nota: viaNota, apollo_at: new Date().toISOString() } : {}),
      notas: [limpio(r.web_estado) ? "web: " + r.web_estado : null, limpio(r.notas)].filter(Boolean).join(" · ") || null,
      created_at: new Date().toISOString(),
    });
  }
  return nuevos;
}

// ---- procesamiento de UNA búsqueda (sirve para los dos carriles) ----
async function procesarBusqueda(b) {
  const esp = b.modo === "especifico";
  const titulo = b.rubro + (b.zona ? " — " + b.zona : "");
  console.log("\n==> " + (esp ? "⚡📍 " : "") + titulo + (esp ? " (carril rápido)" : ""));
  await marcar(b.id, "buscando", { progreso: 5, inicio: new Date().toISOString() });

  const existentes = new Set((await api("prospectos?select=empresa")).map(x => String(x.empresa || "").trim().toLowerCase()));

  // 1) DESCUBRIR (scraper MIT) — o vacío para que el agente busque solo
  let lista = [];
  if (SCRAPER) {
    try { lista = await correrScraper(b, pr => marcar(b.id, "buscando", { progreso: pr })); console.log("  Scraper: " + lista.length + " negocios crudos."); }
    catch (e) { console.error("  Scraper falló: " + e.message); }
  }
  await marcar(b.id, "buscando", { progreso: 40 });

  // 2) JUZGAR + CARGAR por tandas de 20
  const TANDA = 20;
  const base = lista;
  const tandas = base.length ? Array.from({ length: Math.ceil(base.length / TANDA) }, (_, i) => base.slice(i * TANDA, (i + 1) * TANDA)) : [null];
  const aprendizaje = esp ? "" : await aprendizajeDuenio();
  if (aprendizaje) console.log("  Aprendizaje del dueño cargado (" + (aprendizaje.match(/\n- /g) || []).length + " ejemplos).");
  let total = [], huboExito = false, hechas = 0;
  const PARALELO = 3;
  const procesarTanda = async (parte, i) => {
    const nota = parte && tandas.length > 1 ? "NOTA: esta es la tanda " + (i + 1) + " de " + tandas.length + " de la misma búsqueda. Procesá SOLO los negocios de la lista de abajo." : "";
    console.log(parte ? "  Tanda " + (i + 1) + "/" + tandas.length + " (" + parte.length + " negocios) -> analizando..." : "  Sin lista — el agente busca solo (puede tardar)...");
    const rows = await juzgar(b, parte ? JSON.stringify(parte, null, 1) : "(vacía)", nota, aprendizaje);
    hechas++;
    await marcar(b.id, "buscando", { progreso: Math.min(97, 40 + Math.round(57 * hechas / tandas.length)) });
    if (rows === null) return;
    huboExito = true;
    const nuevos = await prepararFilas(rows, b, titulo, existentes);
    if (nuevos.length) {
      try { await api("prospectos", { method: "POST", body: JSON.stringify(nuevos), headers: { Prefer: "return=minimal" } }); total.push(...nuevos); console.log("  + " + nuevos.length + " cargados al panel."); }
      catch (e) { console.error("  No pude insertar la tanda: " + String(e.message).slice(0, 200)); }
    } else { console.log("  (ninguno pasó el filtro en esta tanda)"); }
  };
  for (let i = 0; i < tandas.length; i += PARALELO) {
    const grupo = tandas.slice(i, i + PARALELO).map((parte, j) => procesarTanda(parte, i + j));
    await Promise.all(grupo);
  }

  // 3) CERRAR
  if (!huboExito) { console.error("  Ninguna tanda funcionó — la búsqueda vuelve a pendiente."); await marcar(b.id, "pendiente", { progreso: null }); return; }
  await marcar(b.id, "lista", { progreso: 100 });
  const nA = total.filter(x => x.prioridad === "A").length, nB = total.filter(x => x.prioridad === "B").length, nC = total.filter(x => x.prioridad === "C").length;
  const cont = total.filter(x => x.status === "contactable").length;
  console.log("  ✓ " + total.length + " negocio(s) cargados (A:" + nA + " B:" + nB + " C:" + nC + ") · " + cont + " contactables con email verificado — " + titulo);
}

// ---- REFUERZOS APOLLO (pedidos desde el panel con el botón ⚡) ----
// Prueba con TODAS las personas de la ficha (dueño → manager → marketing). Si la ficha casi
// no tiene gente, le pregunta a Apollo quién trabaja ahí y suma los cargos a las notas.
async function procesarRefuerzos() {
  let pend = [];
  try { pend = (await api("prospectos?apollo_estado=eq.pendiente&select=id,empresa,contacto,web,notas,email_directo&limit=5")) || []; } catch { return; }
  for (const p of pend) {
    const marcarP = (campos) => api("prospectos?id=eq." + p.id, { method: "PATCH", body: JSON.stringify({ ...campos, apollo_at: new Date().toISOString(), updated_at: new Date().toISOString() }) }).catch(() => {});
    if (!APOLLO) { await marcarP({ apollo_estado: "sin_resultado", apollo_nota: "Apollo está apagado: falta APOLLO_API_KEY en el .env del Agente 4" }); continue; }
    console.log("⚡ Refuerzo Apollo pedido desde el panel: " + (p.empresa || ""));

    // 1) Candidatos de la ficha: contacto principal + los de notas ("Cargo: Nombre — ...")
    const candidatos = [];
    const principal = String(p.contacto || "").split(/[—(,]|\s-\s/)[0].trim();
    const cargoPrincipal = (String(p.contacto || "").split("—")[1] || "").trim() || "contacto principal";
    if (principal && principal.includes(" ")) candidatos.push({ nombre: principal, cargo: cargoPrincipal, principal: true });
    for (const linea of String(p.notas || "").split("\n")) {
      const m = linea.match(/^\s*[-•·]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ \/]{3,30}):\s*([A-Za-zÁÉÍÓÚÑáéíóúñ.'-]+\s+[A-Za-zÁÉÍÓÚÑáéíóúñ.'\- ]+?)(?:\s*[—(]|\s*$)/);
      if (m && m[2].trim().includes(" ") && !m[2].includes("@") && !candidatos.some(c => c.nombre.toLowerCase() === m[2].trim().toLowerCase()))
        candidatos.push({ nombre: m[2].trim(), cargo: m[1].trim() });
    }

    // 2) Ficha con poca gente -> preguntarle a Apollo QUIÉN trabaja ahí (no gasta créditos)
    let descubiertos = [];
    if (candidatos.length < 2) {
      descubiertos = await apolloQuienes(p.empresa, p.web);
      for (const d of descubiertos) if (!candidatos.some(c => c.nombre.toLowerCase() === d.nombre.toLowerCase())) candidatos.push(d);
      if (descubiertos.length) console.log("  ⚡ Apollo identificó gente del lugar: " + descubiertos.map(d => d.nombre + (d.cargo ? " (" + d.cargo + ")" : "")).join(" · "));
    }

    if (!candidatos.length) { await marcarP({ apollo_estado: "sin_resultado", apollo_nota: "La ficha no tiene nombre y apellido de ninguna persona — Apollo lo necesita" }); continue; }

    // No gastar créditos en emails que YA tenemos: el principal si hay email_directo,
    // y cualquiera que ya figure en notas con su email al lado.
    const yaTiene = (c) => (c.principal && p.email_directo) ||
      String(p.notas || "").split("\n").some(l => l.includes("@") && l.toLowerCase().includes(c.nombre.toLowerCase()));
    const aProbar = candidatos.filter(c => !yaTiene(c));
    if (!aProbar.length) {
      await marcarP({ apollo_estado: "hecho", apollo_nota: "No hizo falta buscar: ya tenías el email directo de " + candidatos.map(c => c.nombre).join(" y ") + " — no gastó ningún crédito" });
      console.log("  ⚡= Ya tenías esos emails — no se gastó crédito.");
      continue;
    }

    // 3) Probar en orden (dueño primero). Apollo solo cobra crédito cuando encuentra.
    let hit = null, em = null;
    // 3.0) Hunter primero si hay web (cupo gratis aparte del de Apollo)
    if (p.web) {
      const h = await hunterEmail((aProbar[0] && aProbar[0].nombre) || p.contacto || "", p.web);
      if (h && (await emailVivo(h))) { em = h; hit = aProbar[0] || { nombre: String(p.contacto || "").split(/[—(,]/)[0].trim() || "Dueño", cargo: "dueño", principal: true }; console.log("  ⚡✓ Hunter encontró: " + h); }
    }
    if (!hit) for (const c of aProbar) {
      em = await apolloMatch(c.nombre, p.empresa, p.web);
      if (em && (await emailVivo(em))) { hit = c; break; }
      em = null;
    }

    const lineasNuevas = descubiertos.filter(d => !hit || d.nombre !== hit.nombre).map(d => (d.cargo || "Equipo") + ": " + d.nombre + " (⚡ Apollo)");
    if (hit) {
      const campos = { apollo_estado: "hecho", status: "contactable" };
      if (hit.principal) { campos.email_directo = em; campos.apollo_nota = "Agregó el email directo de " + hit.nombre + " (" + hit.cargo + "): " + em; }
      else {
        lineasNuevas.unshift((hit.cargo || "Equipo") + ": " + hit.nombre + " — " + em + " (⚡ Apollo)");
        campos.apollo_nota = "Encontró el email directo de " + hit.nombre + " (" + (hit.cargo || "equipo") + ") — quedó en las notas de la ficha";
      }
      if (lineasNuevas.length) campos.notas = [String(p.notas || "").trim(), ...lineasNuevas].filter(Boolean).join("\n");
      await marcarP(campos);
      console.log("  ⚡✓ Apollo encontró: " + em + " (" + hit.nombre + ")");
    } else if (lineasNuevas.length) {
      await marcarP({ apollo_estado: "hecho", apollo_nota: "Sin email verificado, pero identificó gente del lugar: " + descubiertos.map(d => d.nombre + (d.cargo ? " — " + d.cargo : "")).join(" · "), notas: [String(p.notas || "").trim(), ...lineasNuevas].filter(Boolean).join("\n") });
      console.log("  ⚡± Sin email, pero sumó " + lineasNuevas.length + " persona(s) con cargo a la ficha.");
    } else {
      await marcarP({ apollo_estado: "sin_resultado", apollo_nota: "Apollo no encontró un email verificado para " + candidatos.map(c => c.nombre).join(" ni ") });
      console.log("  ⚡✗ Apollo no encontró email verificado (" + candidatos.length + " persona(s) probada(s))");
    }
  }
}

// ---- DOBLE CARRIL ----
// Carril lento: búsquedas por nicho, UNA a la vez (son largas).
// Carril rápido ⚡: las de "lugar puntual" arrancan AL INSTANTE y en paralelo,
// aunque haya un nicho corriendo — no esperan la cola.
const enProceso = new Set();
let lentaOcupada = false;

async function tick(avisarVacio) {
  await procesarRefuerzos();
  const pend = (await api("busquedas?status=eq.pendiente&order=created_at.asc&select=*")) || [];
  const nuevos = pend.filter(b => !enProceso.has(b.id));
  if (!pend.length && !enProceso.size) { if (avisarVacio) console.log("No hay búsquedas pendientes. Pedí una desde el panel (🔎 Buscar)."); return; }

  // ⚡ puntuales: todas ya, en paralelo
  for (const b of nuevos.filter(x => x.modo === "especifico")) {
    enProceso.add(b.id);
    procesarBusqueda(b).catch(e => console.error("Error (puntual): " + String(e.message).slice(0, 200))).finally(() => enProceso.delete(b.id));
  }
  // nichos: de a uno
  const nichos = nuevos.filter(x => x.modo !== "especifico");
  if (nichos.length && !lentaOcupada) {
    const b = nichos[0];
    lentaOcupada = true; enProceso.add(b.id);
    procesarBusqueda(b).catch(e => console.error("Error (nicho): " + String(e.message).slice(0, 200))).finally(() => { lentaOcupada = false; enProceso.delete(b.id); });
  }
}

// Normal: procesa lo pendiente y termina.  Con --vigilar: queda mirando el panel
// (revisa cada 20s; las puntuales entran al carril rápido al instante).
const VIGILAR = process.argv.includes("--vigilar");
if (!VIGILAR) {
  // una pasada: refuerzos de Apollo primero, después puntuales, después los nichos
  await procesarRefuerzos();
  const pend = (await api("busquedas?status=eq.pendiente&order=created_at.asc&select=*")) || [];
  if (!pend.length) console.log("No hay búsquedas pendientes. Pedí una desde el panel (🔎 Buscar).");
  const orden = [...pend.filter(x => x.modo === "especifico"), ...pend.filter(x => x.modo !== "especifico")];
  for (const b of orden) { try { await procesarBusqueda(b); } catch (e) { console.error("Error: " + String(e.message).slice(0, 200)); } }
  if (pend.length) console.log("\nListo. Mirá CAPTACIÓN CLIENTES en el panel.");
} else {
  console.log("Modo vigilancia con DOBLE CARRIL: los nichos van de a uno; las búsquedas de lugar puntual ⚡ arrancan al instante en paralelo (reviso cada 20s). Dejá esta ventana abierta.");
  for (;;) {
    try { await tick(false); } catch (e) { console.error("Error: " + String(e.message).slice(0, 200)); }
    await new Promise(r => setTimeout(r, 20000));
  }
}
