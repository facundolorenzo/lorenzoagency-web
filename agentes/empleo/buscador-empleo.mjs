// MOTOR DE EMPLEO — LORENZO Agency / Cronos
// Lee los perfiles activos del panel (pestaña EMPLEO), busca empresas que contratan con el
// cerebro (claude -p, gratis con tu cuenta), identifica al decisor, redacta el mail y lo carga
// en el panel. Busca domingo a viernes a las 18:00 (EMPLEO_HORA) y cuando tocás "Buscar ahora".
// PILOTO AUTOMÁTICO: un agente de control revisa cada mail, los aprobados se programan para
// el próximo día hábil (8:00 Este / 11:00 Oeste) y salen solos desde tu Gmail con el presskit;
// después vigila tu bandeja (IMAP) y marca quién respondió, con aviso en Windows.
// .env extra: EMPLEO_MAIL_USER, EMPLEO_MAIL_PASS (contraseña de aplicación de Gmail), EMPLEO_CANTIDAD
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
const PROMPT_CONTROL = existsSync(join(DIR, "PROMPT-CONTROL-EMPLEO.md")) ? readFileSync(join(DIR, "PROMPT-CONTROL-EMPLEO.md"), "utf8") : "";
const MAIL_USER = env.EMPLEO_MAIL_USER || "", MAIL_PASS = env.EMPLEO_MAIL_PASS || "";
const DIAS_BUSQUEDA = [0, 1, 2, 3, 4, 5]; // dom a vie
const DIAS_ENVIO = [1, 2, 3, 4, 5];       // lun a vie
const OESTE = /\b(CA|WA|OR|NV|AZ|CO|UT|ID|MT|NM|AK|HI)\b|San Francisco|Los Angeles|Seattle|Portland|Denver|Phoenix|San Diego|Oakland|Palo Alto|Mountain View|Bay Area|Austin|Dallas|Houston|Chicago/i;
const HORA_ENVIO_OESTE = 11;
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

// Hunter.io (misma key del .env que usa el Agente 4): email del decisor por nombre + dominio
const HUNTER = env.HUNTER_API_KEY || null;
let hunterUsadosEmp = 0;
const HUNTER_MAX_EMP = 5;
async function hunterMatch(nombre, web) {
  if (!HUNTER || hunterUsadosEmp >= HUNTER_MAX_EMP) return null;
  let dominio; try { dominio = new URL(String(web || "").startsWith("http") ? web : "https://" + web).hostname.replace(/^www\./, ""); } catch { return null; }
  if (!dominio) return null;
  const partes = String(nombre || "").trim().split(/\s+/);
  if (partes.length < 2) return null;
  try {
    const r = await fetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(dominio)}&first_name=${encodeURIComponent(partes[0])}&last_name=${encodeURIComponent(partes.slice(1).join(" "))}&api_key=${HUNTER}`);
    if (!r.ok) return null;
    hunterUsadosEmp++;
    const d = ((await r.json()) || {}).data;
    if (d && d.email && (d.score || 0) >= 80) return d.email;
  } catch {}
  return null;
}
// Cascada de email del decisor: 1º Apollo (persona) → 2º Hunter (dominio) si Apollo no encuentra
async function emailDecisor(nombre, empresa, web) {
  const ap = await apolloMatch(nombre, empresa, web);
  if (ap) return { email: ap, via: "Apollo" };
  const hu = await hunterMatch(nombre, web);
  if (hu) return { email: hu, via: "Hunter" };
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

async function cerebro(perfil, yaTengo, cant) {
  const vars = [
    "## PERFIL",
    "NOMBRE: " + perfil.nombre,
    "ROLES QUE BUSCA: " + (perfil.roles || "(no definido)"),
    "PAÍS: " + (perfil.pais || "Estados Unidos") + " · VIVE EN: " + (perfil.ubicacion || "(no dice)") + " · MODALIDAD ACEPTADA: " + (perfil.modalidad || "cualquiera") + " (presencial/híbrido solo si la empresa está cerca de donde vive)",
    "SALARIO MÍNIMO: " + (perfil.salario_min ? "$" + perfil.salario_min + "k/año" : "(sin mínimo)"),
    "ETAPAS DE EMPRESA: " + (perfil.etapas || "cualquiera"),
    "CONTRATO: " + (perfil.contrato || "cualquiera"),
    "EXPERIENCIA: " + (perfil.experiencia || "(no cargada)"),
    "LO QUE LO HACE DISTINTO: " + (perfil.distinto || ""),
    "QUÉ LO MOTIVA (carril 'motiva'): " + (perfil.intereses || "(no definido)"),
    "OTRAS CIUDADES A LAS QUE SE MUDARÍA (solo para empresas que lo motivan; respetá el 'cuándo' si lo dice): " + (perfil.ciudades_extra || "(ninguna)"),
    "QUÉ NO LO MOTIVA (igual sirve si es remoto y paga): " + (perfil.evitar || "(nada en particular)"),
    "PROYECTOS: " + (perfil.proyectos || ""),
    perfil.linkedin ? "LINKEDIN: " + perfil.linkedin : "",
    perfil.ejemplo_mail ? "\n## MAIL QUE EL DUEÑO DEJÓ A MANO (es el tono EXACTO que quiere; copiá voz, estructura, largo y nivel de inglés. NO copies los datos de esa empresa ni su gancho, solo el estilo):\n" + perfil.ejemplo_mail : "",
    (perfil._enviados && perfil._enviados.length) ? "\n## ÚLTIMOS MAILS ENVIADOS POR EL CANDIDATO — LA VARA DE CALIDAD (imitá voz, enfoque, estructura y largo; NO copies los datos de esas empresas):\n" + perfil._enviados.map((m, i) => "--- MAIL " + (i + 1) + " (a " + m.empresa + ") ---\n" + m.mail_cuerpo).join("\n\n") : "",
    (perfil._radar && perfil._radar.length) ? "\n## AVISOS FRESCOS DEL RADAR (complemento para volumen; su match suele ser más bajo). Revisá los que peguen de verdad con los roles, PERO tu prioridad sigue siendo cazar startups de IA chicas con decisor identificable (match alto). Hacé LAS DOS COSAS; no te quedes solo con el radar:\n- " + perfil._radar.join("\n- ") : "",
    perfil.notas_estilo ? "\n## CÓMO LE GUSTAN LOS MAILS (respetalo):\n" + perfil.notas_estilo : "",
    "\n## MAIL BASE (respetá estructura y tono; completá {nombre} {empresa} {rol} {gancho})",
    "ASUNTO BASE: " + (perfil.mail_asunto || "(vacío)"),
    perfil.mail_base || "(vacío: escribí uno corto según las reglas)",
    "\n## CANTIDAD: traé hasta " + (cant || CANTIDAD) + " empresas nuevas EN ESTA PASADA (las mejores que encuentres ahora; habrá más pasadas después, no hace falta agotar todo acá)",
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
  // Rescate robusto: a veces el CLI devuelve el array sin el bloque <EMPRESAS> o dentro de ```json```
  const intentos = [];
  const m = out.match(/<EMPRESAS>([\s\S]*?)<\/EMPRESAS>/); if (m) intentos.push(m[1]);
  const f = out.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) intentos.push(f[1]);
  const i = out.indexOf("["), j = out.lastIndexOf("]"); if (i >= 0 && j > i) intentos.push(out.slice(i, j + 1));
  for (const s of intentos) { try { const v = JSON.parse(String(s).trim()); if (Array.isArray(v)) return v; } catch {} }
  console.error("  El cerebro no devolvió empresas en formato usable (reintentá la búsqueda). Final:\n" + out.slice(-400));
  return null;
}

// ---- RADAR: fuentes estructuradas gratis (complemento del cerebro, nunca lo reemplaza) ----
// Baja avisos frescos en segundos de HN "Who is hiring", RemoteOK y WeWorkRemotely,
// los filtra por rol/remoto/sueldo del perfil y se los acerca al cerebro como punto de partida.
const RADAR_TIMEOUT = 20000;
async function radarFetch(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), RADAR_TIMEOUT);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    return (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text();
  } catch { return null; } finally { clearTimeout(t); }
}
const radarTxt = s => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();
async function radar(perfil, tope = 100) {
  const capHN = Math.round(tope * 0.45), capRO = Math.round(tope * 0.4), capWWR = Math.round(tope * 0.2);
  const kws = [...new Set([
    ...String(perfil.roles || "").toLowerCase().split(/[·,\/|\n]+/).map(s => s.trim()).filter(s => s.length > 3),
    "ai engineer", "founding engineer", "forward deployed", "applied ai", "full stack", "full-stack", "product engineer", "ai automation", "solutions engineer",
  ])];
  const matchKw = t => { const lt = String(t).toLowerCase(); return kws.some(k => lt.includes(k)); };
  const minSal = (Number(perfil.salario_min) || 0) * 1000;
  const items = [];
  // 1) Hacker News "Who is hiring" (el hilo del mes)
  try {
    const s = await radarFetch("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22Ask%20HN%3A%20Who%20is%20hiring%3F%22&hitsPerPage=1");
    const id = s && s.hits && s.hits[0] && s.hits[0].objectID;
    if (id) {
      const th = await radarFetch("https://hn.algolia.com/api/v1/items/" + id);
      let n = 0;
      for (const c of (th && th.children) || []) {
        if (n >= capHN) break;
        const txt = radarTxt(c && c.text); if (!txt || !matchKw(txt)) continue;
        if (!/remote|usa|united states|miami|new york|nyc|san francisco|austin|boston|denver|seattle/i.test(txt)) continue;
        items.push("HN Who is hiring (" + String(c.created_at || "").slice(0, 10) + "): " + txt.slice(0, 260) + " — https://news.ycombinator.com/item?id=" + c.id);
        n++;
      }
    }
  } catch {}
  // 2) RemoteOK
  try {
    const j = await radarFetch("https://remoteok.com/api");
    let n = 0;
    for (const o of Array.isArray(j) ? j : []) {
      if (!o || !o.position || n >= capRO) continue;
      const blob = o.position + " " + (Array.isArray(o.tags) ? o.tags.join(" ") : "") + " " + String(o.description || "").slice(0, 300);
      if (!matchKw(blob)) continue;
      if (minSal && o.salary_max && Number(o.salary_max) < minSal) continue;
      items.push("RemoteOK (" + String(o.date || "").slice(0, 10) + "): " + (o.company || "?") + " — " + o.position + (o.salary_min ? " — $" + o.salary_min + "–" + (o.salary_max || "?") : "") + " — " + (o.url || "https://remoteok.com/l/" + o.id));
      n++;
    }
  } catch {}
  // 3) WeWorkRemotely (RSS)
  try {
    const x = await radarFetch("https://weworkremotely.com/categories/remote-programming-jobs.rss");
    if (typeof x === "string") {
      let n = 0;
      for (const m of x.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        if (n >= capWWR) break;
        const it = m[1];
        const title = radarTxt((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
        const link = radarTxt((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]);
        const fecha = radarTxt((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]).slice(0, 16);
        if (!title || !matchKw(title)) continue;
        items.push("WeWorkRemotely (" + fecha + "): " + title + " — " + link);
        n++;
      }
    }
  } catch {}
  console.log(items.length ? "  📡 Radar: " + items.length + " avisos frescos pasan tu filtro (HN / RemoteOK / WWR). Se los paso al cerebro como punto de partida." : "  📡 Radar: hoy sin resultados nuevos — el cerebro busca solo, como siempre.");
  return items;
}

async function correr(perfil, motivo) {
  console.log(`\n[${new Date().toLocaleTimeString()}] Buscando para ${perfil.nombre} (${motivo})…`);
  await patchPerfil(perfil.id, { estado_motor: "buscando", pedido_busqueda: false });
  // Barra de avance (best-effort: si falta el SQL v7 solo deja un aviso en consola y sigue)
  const avance = (obj) => patchPerfil(perfil.id, obj);
  await avance({ progreso: 5, busqueda_inicio: new Date().toISOString() });
  const existentes = (await api(`empleos?perfil_id=eq.${perfil.id}&select=empresa`)) || [];
  const ya = new Set(existentes.map(x => String(x.empresa).toLowerCase().trim()));
  try { perfil._enviados = (await api(`empleos?perfil_id=eq.${perfil.id}&status=in.(enviado,respondio)&mail_cuerpo=not.is.null&select=empresa,mail_cuerpo&order=enviado_at.desc.nullslast&limit=4`)) || []; } catch { perfil._enviados = []; }
  try { perfil._radar = await radar(perfil); } catch { perfil._radar = []; }
  const TANDA = 5;
  const OBJETIVO = Number(env.EMPLEO_OBJETIVO || 15);   // cuántas CON email del decisor querés listas por día
  const MAX_REVISAR = Number(env.EMPLEO_MAX || 50);     // tope de empresas a analizar a fondo (cuida tiempo y créditos)
  let totRev = 0, totNue = 0, totConEmail = 0, falloInicial = false, t = 0, fallos = 0, radarSubido = false;
  while (totConEmail < OBJETIVO && totRev < MAX_REVISAR) {
    t++;
    console.log(`  Tanda ${t} (de a ${TANDA}) — listas con email: ${totConEmail}/${OBJETIVO}, revisadas ${totRev}/${MAX_REVISAR}…`);
    const rows = await cerebro(perfil, [...ya], TANDA);
    if (!rows) { if (t === 1 && !radarSubido) { falloInicial = true; break; } if (++fallos >= 3) { console.log("  Varias tandas sin respuesta usable; corto."); break; } console.log("  Esta tanda no devolvió empresas usables; reintento la próxima."); continue; }
    totRev += rows.length; fallos = 0;
    const r = await procesarTanda(perfil, rows, ya, async () => { await avance({ progreso: Math.min(95, 5 + Math.round((totConEmail / OBJETIVO) * 90)) }); });
    totNue += r.insertadas; totConEmail += r.conEmail;
    console.log(`  Tanda ${t}: +${r.insertadas} nuevas (${r.conEmail} con email del decisor). Listas para enviar: ${totConEmail}/${OBJETIVO}.`);
    await avance({ progreso: Math.min(95, 5 + Math.round((totConEmail / OBJETIVO) * 90)) });
    if (r.insertadas === 0) {
      if (!radarSubido) {   // se quedó sin candidatos antes de llegar al objetivo → subo el radar a 200 y sigo
        radarSubido = true;
        console.log(`  📡 Me quedé corto (${totConEmail}/${OBJETIVO}) — subo el radar a 200 y sigo buscando.`);
        try { perfil._radar = await radar(perfil, 200); } catch {}
        continue;
      }
      console.log("  Ya con radar ampliado no aparecen nuevas; corto acá."); break;
    }
  }
  if (falloInicial) { await patchPerfil(perfil.id, { estado_motor: "error", ultima_corrida: new Date().toISOString() }); await avance({ progreso: null, busqueda_inicio: null }); return; }
  await patchPerfil(perfil.id, { estado_motor: "lista", ultima_corrida: new Date().toISOString(), ultima_revisadas: totRev, ultima_nuevas: totNue });
  await avance({ progreso: null, busqueda_inicio: null });
  console.log(`  Listo: ${totRev} revisadas, ${totNue} nuevas (${totConEmail} con email directo, listas para enviar) en el panel (EMPLEO → Para hoy).`);
  try { await controlCalidad(perfil); } catch (e) { console.error("  Control: " + String(e.message).slice(0, 160)); }
}
async function procesarTanda(perfil, rows, ya, onCada) {
  let insertadas = 0, conEmail = 0;
  // procesar las de MAYOR match primero, para que lo mejor caiga antes en el panel
  rows = [...rows].sort((a, b) => (Number(b.match) || 0) - (Number(a.match) || 0));
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const emp = limpio(r.empresa); if (!emp || ya.has(emp.toLowerCase())) continue;
    let email = limpio(r.decisor_email), verif = !!r.decisor_email_verificado, nota = limpio(r.notas), apEst = null;
    if (email && /^(jobs|careers|hello|info|contact|hr|talent|team)@/i.test(email)) { nota = [nota, "email genérico: " + email].filter(Boolean).join(" · "); email = null; verif = false; }
    if (email && !(await emailVivo(email))) { nota = [nota, "dominio sin correo, descartado: " + email].filter(Boolean).join(" · "); email = null; verif = false; }
    // Apollo solo para los candidatos fuertes sin email (cuida los créditos)
    if (!email && APOLLO && limpio(r.decisor_nombre) && Number(r.match) >= 60) {
      const res = await emailDecisor(r.decisor_nombre, emp, r.web);
      if (res && (await emailVivo(res.email))) { email = res.email; verif = true; apEst = "hecho"; nota = [nota, res.via + " encontró el email del decisor"].filter(Boolean).join(" · "); console.log("  ⭐ " + res.via + ": " + r.decisor_nombre + " @ " + emp); }
      else apEst = "sin_resultado";
    }
    ya.add(emp.toLowerCase());
    const fila = {
      perfil_id: perfil.id, empresa: emp, web: limpio(r.web), ciudad: limpio(r.ciudad), tamano: limpio(r.tamano), etapa: limpio(r.etapa),
      rol: limpio(r.rol), salario: limpio(r.salario), modalidad: limpio(r.modalidad), fuente: limpio(r.fuente), url_aviso: limpio(r.url_aviso),
      publicado: limpio(r.publicado), senal: limpio(r.senal), descripcion: limpio(r.descripcion),
      decisor_nombre: limpio(r.decisor_nombre), decisor_cargo: limpio(r.decisor_cargo), decisor_email: email, decisor_email_verificado: verif, decisor_linkedin: limpio(r.decisor_linkedin),
      match: Number.isFinite(Number(r.match)) ? Math.max(0, Math.min(100, Math.round(Number(r.match)))) : null,
      motivacion: Number.isFinite(Number(r.motivacion)) ? Math.max(0, Math.min(100, Math.round(Number(r.motivacion)))) : null,
      carril: ["remoto", "motiva", "ambos"].includes(r.carril) ? r.carril : null,
      ganchos: Array.isArray(r.ganchos) ? r.ganchos.map(x=>String(x).trim()).filter(Boolean).slice(0,6).join("\n") : null,
      por_que: limpio(r.por_que), mail_asunto: limpio(r.mail_asunto), mail_cuerpo: limpio(r.mail_cuerpo),
      status: "nuevo", apollo_estado: apEst, apollo_nota: apEst === "sin_resultado" ? "Apollo no encontró email verificado" : null,
      notas: [nota, limpio(r.gancho_fuente) ? "Gancho: " + r.gancho_fuente + (limpio(r.gancho_fecha) ? " (" + r.gancho_fecha + ")" : "") : null].filter(Boolean).join(" · ") || null,
      created_at: new Date().toISOString(),
    };
    try { await api("empleos", { method: "POST", body: JSON.stringify([fila]) }); insertadas++; if (email) conEmail++; console.log("    + " + emp + (email ? " ⭐ (con email, lista para enviar)" : "") + " — match " + (fila.match ?? "?")); } catch (e) { console.error("    no se pudo insertar " + emp + ": " + String(e.message).slice(0, 120)); }
    if (onCada) { try { await onCada(idx, rows.length); } catch {} }
  }
  return { insertadas, conEmail };
}

// ---------- PILOTO AUTOMÁTICO ----------
function proximoEnvio(ciudad, horaBase) {
  const d = new Date(); const oeste = OESTE.test(String(ciudad || "")) && !/Miami|New York|Boston|Atlanta|Washington|Philadelphia|Charlotte|Tampa|Orlando|Brooklyn|Manhattan|NYC|FL|NY|MA|GA|DC|PA|NC/i.test(String(ciudad || ""));
  const hora = oeste ? Math.max(horaBase, HORA_ENVIO_OESTE) : horaBase;
  d.setHours(hora, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  while (!DIAS_ENVIO.includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d;
}

// Agente de control: revisa los mails nuevos del perfil y aprueba o manda a revisión manual
async function controlCalidad(perfil) {
  if (!perfil.auto_envio) return;
  const cand = (await api(`empleos?perfil_id=eq.${perfil.id}&status=eq.nuevo&qa_estado=is.null&decisor_email=not.is.null&select=id,empresa,rol,ciudad,decisor_nombre,decisor_cargo,decisor_email,decisor_email_verificado,match,mail_asunto,mail_cuerpo,notas,senal,descripcion,feedback&order=match.desc&limit=30`)) || [];
  const lista = cand.filter(e => e.feedback !== "no" && e.mail_cuerpo);
  if (!lista.length) return;
  console.log(`  Control de calidad: revisando ${lista.length} mails…`);
  let aprobados = [];
  if (PROMPT_CONTROL) {
    const entrada = lista.map(e => ({ id: e.id, empresa: e.empresa, rol: e.rol, decisor_nombre: e.decisor_nombre, decisor_cargo: e.decisor_cargo, decisor_email: e.decisor_email, verificado: !!e.decisor_email_verificado, match: e.match, asunto: e.mail_asunto, mail: e.mail_cuerpo, notas: e.notas, senal: e.senal, descripcion: e.descripcion }));
    let out = "";
    try {
      const child = execFileP("claude", ["-p", "--dangerously-skip-permissions"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 20, timeout: 1000 * 60 * 20, shell: WIN });
      child.child.stdin.end(PROMPT_CONTROL + "\n\nPERFIL: " + perfil.nombre + " · " + (perfil.email_envio || "") + "\nFECHA DE HOY: " + new Date().toISOString().slice(0, 10) + "\n\n<MAILS>\n" + JSON.stringify(entrada, null, 1) + "\n</MAILS>");
      out = (await child).stdout || "";
    } catch (e) { console.error("  El control falló: " + String(e.message).slice(0, 200)); return; }
    const m = out.match(/<CONTROL>([\s\S]*?)<\/CONTROL>/); if (!m) { console.error("  Control sin bloque <CONTROL>"); return; }
    let res = []; try { res = JSON.parse(m[1]); } catch { console.error("  Control: JSON inválido"); return; }
    for (const r of res) {
      const e = lista.find(x => x.id === r.id); if (!e) continue;
      const ok = !!r.aprobado && Number(e.match) >= 70;
      const patch = { qa_estado: ok ? "ok" : "revisar", qa_nota: limpio(r.nota), updated_at: new Date().toISOString() };
      if (ok) { const cuando = proximoEnvio(e.ciudad, Number(perfil.hora_envio || 8)); patch.status = "programado"; patch.programado_para = cuando.toISOString(); aprobados.push(e.empresa + " → " + cuando.toLocaleString("es-AR", { weekday: "short", hour: "2-digit", minute: "2-digit" })); }
      await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify(patch) });
    }
  }
  console.log(aprobados.length ? "  ✓ Programados: " + aprobados.join(" · ") : "  Ningún mail aprobado por el control (quedan en Para hoy para que los mires).");
}

async function presskitB64(url) {
  if (!url) return null;
  try { const r = await fetch(url); const b = Buffer.from(await r.arrayBuffer()); return b.toString("base64"); } catch { return null; }
}
async function enviarProgramados() {
  const perfiles = (await api("perfiles_empleo?activo=eq.true&auto_envio=eq.true&select=*")) || [];
  for (const p of perfiles) {
    const hoy0 = new Date(); hoy0.setHours(0, 0, 0, 0);
    const enviadosHoy = ((await api(`empleos?perfil_id=eq.${p.id}&status=in.(enviado,respondio)&enviado_at=gte.${hoy0.toISOString()}&select=id`)) || []).length;
    const tope = Number(p.tope_diario || 5);
    if (enviadosHoy >= tope) continue;
    const listos = (await api(`empleos?perfil_id=eq.${p.id}&status=eq.programado&programado_para=lte.${new Date().toISOString()}&select=*&order=match.desc&limit=${tope - enviadosHoy}`)) || [];
    if (!listos.length) continue;
    let pk = null;
    for (const e of listos) {
      if (!e.decisor_email || !e.mail_cuerpo) { await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ status: "nuevo", qa_estado: "revisar", qa_nota: "Sin email o sin mail al momento de enviar" }) }); continue; }
      if (pk === null) pk = await presskitB64(p.presskit_url || p.cv_url);
      const adjuntos = pk ? [{ nombre: p.presskit_url ? (p.presskit_nombre || "presskit.pdf") : (p.cv_nombre || "cv.pdf"), tipo: "application/pdf", base64: pk }] : [];
      const r = await fetch(URL_B + "/functions/v1/enviar", { method: "POST", headers: { Authorization: "Bearer " + KEY, apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ to: e.decisor_email, subject: e.mail_asunto || (e.rol + " at " + e.empresa), body: e.mail_cuerpo, adjuntos, cuenta: p.cuenta || "empleo" }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ status: "enviado", enviado_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
        console.log(`  ✉ Enviado a ${e.decisor_nombre} (${e.empresa}) desde ${p.email_envio || "tu casilla"}`);
      } else {
        await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ status: "nuevo", qa_estado: "revisar", qa_nota: "No se pudo enviar: " + String(j.error || r.status).slice(0, 160), updated_at: new Date().toISOString() }) });
        console.error("  ✗ No salió el mail a " + e.empresa + ": " + String(j.error || r.status).slice(0, 160));
        if (/secrets|EMPLEO_MAIL/i.test(String(j.error || ""))) break; // sin Gmail configurado, no insistir
      }
      await new Promise(r => setTimeout(r, 20000 + Math.random() * 40000)); // 20-60 s entre mails, como una persona
    }
  }
}

// ---------- RESPUESTAS (IMAP Gmail) ----------
import { connect as tlsConnect } from "node:tls";
function imapBuscarRemitentes(emails, desde) {
  return new Promise((resolve) => {
    if (!MAIL_USER || !MAIL_PASS || !emails.length) return resolve(new Set());
    const sock = tlsConnect({ host: "imap.gmail.com", port: 993, servername: "imap.gmail.com" });
    let buf = "", n = 0, cola = [], hallados = new Set(), actual = null;
    const send = (cmd) => { const tag = "a" + (++n); sock.write(tag + " " + cmd + "\r\n"); return tag; };
    const fin = () => { try { sock.end(); } catch {} resolve(hallados); };
    const t = setTimeout(fin, 25000);
    const fecha = new Date(desde); const d = fecha.getDate() + "-" + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][fecha.getMonth()] + "-" + fecha.getFullYear();
    const paso = () => {
      if (!cola.length) { clearTimeout(t); return fin(); }
      actual = cola.shift(); actual.tag = send(actual.cmd);
    };
    sock.on("data", (c) => {
      buf += c.toString();
      if (!actual) { if (/OK/.test(buf)) { buf = ""; cola = [{ cmd: 'LOGIN "' + MAIL_USER + '" "' + MAIL_PASS.replace(/"/g, '\\"') + '"' }, { cmd: "SELECT INBOX" }, ...emails.map(em => ({ cmd: 'SEARCH FROM "' + em + '" SINCE ' + d, email: em }))]; paso(); } return; }
      const re = new RegExp("^" + actual.tag + " (OK|NO|BAD)", "m");
      if (re.test(buf)) {
        if (actual.email) { const m = buf.match(/\* SEARCH([ \d]*)/); if (m && m[1].trim()) hallados.add(actual.email); }
        if (/ NO| BAD/.test((buf.match(re) || [""])[0]) && !actual.email) { clearTimeout(t); return fin(); }
        buf = ""; paso();
      }
    });
    sock.on("error", () => { clearTimeout(t); fin(); });
  });
}
function avisoWindows(titulo, texto) {
  if (!WIN) return;
  try {
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $x=$t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode('${titulo.replace(/'/g, "")}')) > $null; $x.Item(1).AppendChild($t.CreateTextNode('${texto.replace(/'/g, "")}')) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('LORENZO Empleo').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], () => {});
  } catch {}
}
let _ultimoRespCheck = 0;
async function revisarRespuestas() {
  if (!MAIL_USER || !MAIL_PASS) return;
  if (Date.now() - _ultimoRespCheck < 10 * 60 * 1000) return; _ultimoRespCheck = Date.now();
  const env = (await api("empleos?status=eq.enviado&decisor_email=not.is.null&select=id,empresa,decisor_nombre,decisor_email,enviado_at")) || [];
  if (!env.length) return;
  const desde = env.reduce((a, e) => (a < e.enviado_at ? a : e.enviado_at), env[0].enviado_at);
  const hall = await imapBuscarRemitentes([...new Set(env.map(e => e.decisor_email))], desde);
  for (const e of env) {
    if (!hall.has(e.decisor_email)) continue;
    await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ status: "respondio", respondio_at: new Date().toISOString(), visto: false, updated_at: new Date().toISOString() }) });
    console.log(`  ★ RESPONDIÓ: ${e.decisor_nombre} de ${e.empresa}`);
    avisoWindows("Te respondieron: " + e.empresa, (e.decisor_nombre || "") + " contestó tu mail. Miralo en EMPLEO → Seguimiento.");
  }
}

// Pedidos sueltos de Apollo desde el panel ("⚡ Buscar email")
async function refuerzosApollo() {
  if (!APOLLO) return;
  const pend = (await api("empleos?apollo_estado=eq.pendiente&select=id,empresa,web,decisor_nombre")) || [];
  for (const e of pend) {
    if (!e.decisor_nombre) { await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ apollo_estado: "sin_resultado", apollo_nota: "No hay nombre del decisor para buscar" }) }); continue; }
    const res = await emailDecisor(e.decisor_nombre, e.empresa, e.web);
    const ap = res && res.email;
    const ok = ap && (await emailVivo(ap));
    await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify(ok ? { decisor_email: ap, decisor_email_verificado: true, apollo_estado: "hecho", apollo_nota: (res.via || "Apollo") + " encontró el email verificado", updated_at: new Date().toISOString() } : { apollo_estado: "sin_resultado", apollo_nota: "Ni Hunter ni Apollo encontraron un email verificado de " + e.decisor_nombre, updated_at: new Date().toISOString() }) });
    console.log((ok ? "  ⭐ " + (res.via || "?") + " encontró: " : "  Sin resultado (Hunter+Apollo): ") + e.decisor_nombre + " @ " + e.empresa);
  }
}

const hoyKey = () => new Date().toISOString().slice(0, 10);
const diaLocal = (x) => { const d = new Date(x); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
function tocaHoy(p) {
  if (p.pedido_busqueda) return "pedido desde el panel";
  if (p.estado_motor === "buscando") return null;
  const ahora = new Date();
  if (!DIAS_BUSQUEDA.includes(ahora.getDay())) return null;
  if (ahora.getHours() < HORA) return null;
  if (!p.ultima_corrida) return "primera corrida";
  if (diaLocal(p.ultima_corrida) !== diaLocal(ahora)) return "corrida diaria";
  return null;
}
// Regenerar el mail de una empresa cuando el dueño lo pide desde el panel (botón Regenerar)
async function regenerarMails() {
  const pend = (await api("empleos?regenerar=eq.true&select=*&limit=10")) || [];
  for (const e of pend) {
    const perfil = (await api("perfiles_empleo?id=eq." + e.perfil_id + "&select=*"))?.[0];
    if (!perfil) { await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ regenerar: false }) }); continue; }
    try { perfil._enviados = (await api(`empleos?perfil_id=eq.${perfil.id}&status=in.(enviado,respondio)&mail_cuerpo=not.is.null&select=empresa,mail_cuerpo&order=enviado_at.desc.nullslast&limit=4`)) || []; } catch { perfil._enviados = []; }
    console.log(`  ↻ Regenerando mail para ${e.empresa}…`);
    const partes = [
      "Reescribí este mail de contacto para un puesto. Devolvé SOLO el mail final en inglés, sin markdown ni comillas, listo para enviar.",
      "\n## REGLAS DEL MAIL",
      "- NO es una plantilla: escribí el mail COMPLETO como lo escribiría el candidato a mano. Si abajo hay ÚLTIMOS MAILS ENVIADOS, esa es LA VARA: imitá su calidad, voz, estructura y largo (sin copiar los datos de esas empresas).",
      "- Construilo desde el ÁNGULO: la ventaja injusta del candidato para ESTA empresa, la más fuerte que sea VERDAD: (1) construyó algo muy parecido con su motor Cronos ('I built my own version of that'); (2) es el usuario exacto del producto; (3) misma ciudad (vive en Miami; desde marzo pasa tiempo en NY) → ofrecer verse en persona; (4) vivió el problema como dueño de negocio (6 años con su marca de eventos, comunidad de 25.000, eventos de 2.000 en 4 ciudades); (5) el aviso pide literalmente su perfil (ex-founder, forward deployed, autodidacta que shippea); (6) la misión lo motiva de verdad.",
      "- Estructura: saludo con primer nombre · P1: observación específica de la empresa integrada natural + el ángulo, SIN plata · P2: Cronos en espejo de lo que ellos hacen (agente principal que delega, control de calidad antes de enviar, aprende de correcciones) · P3: ex-CEO seis años, Hi Dr (2018), criterio de producto · extra solo si aplica al aviso (trial paga ok / estoy probando su producto / verse en persona) · cierre 'Let me know if it makes sense to connect. My resume is attached.'",
      "- NUNCA plata (montos, rondas, 'raised', inversores, valuación). Nunca '15-minute call' ni 'quick chat'.",
      "- Inglés simple y natural (el candidato tiene inglés intermedio). Sin guiones largos, sin emojis, sin signos de exclamación. Máximo ~150 palabras.",
      perfil.ejemplo_mail ? "\n## MAIL QUE EL CANDIDATO DEJÓ A MANO (tono EXACTO que quiere; copiá voz, estructura, largo y nivel de inglés, NO los datos de esa empresa):\n" + perfil.ejemplo_mail : "",
      (perfil._enviados && perfil._enviados.length) ? "\n## ÚLTIMOS MAILS ENVIADOS POR EL CANDIDATO — LA VARA DE CALIDAD (imitá voz, enfoque, estructura y largo; NO copies los datos de esas empresas):\n" + perfil._enviados.map((m, i) => "--- MAIL " + (i + 1) + " (a " + m.empresa + ") ---\n" + m.mail_cuerpo).join("\n\n") : "",
      perfil.notas_estilo ? "\n## CÓMO LE GUSTAN LOS MAILS AL CANDIDATO (respetalo):\n" + perfil.notas_estilo : "",
      e.feedback_nota ? "\n## OBSERVACIÓN DEL CANDIDATO SOBRE ESTE MAIL:\n" + e.feedback_nota : "",
      e.instruccion_mail ? "\n## INSTRUCCIÓN PARA ESTA REESCRITURA (lo más importante):\n" + e.instruccion_mail : "",
      "\n## MAIL BASE DEL CANDIDATO\nASUNTO: " + (perfil.mail_asunto || "{rol} at {empresa}") + "\n" + (perfil.mail_base || ""),
      "\n## DATOS DE LA EMPRESA",
      "Empresa: " + e.empresa, "Rol: " + (e.rol || ""), "Decisor: " + (e.decisor_nombre || "") + " (" + (e.decisor_cargo || "") + ")",
      "Qué hacen: " + (e.descripcion || ""), "Señal/novedad: " + (e.senal || ""), "Notas: " + (e.notas || ""),
      e.por_que ? "Por qué encaja (análisis ya hecho — DE ACÁ sale el ÁNGULO del mail): " + e.por_que : "",
      "\n## SALIDA: devolvé SOLO este JSON (sin markdown): {\"mail\": \"<el mail completo empezando por 'Hi " + String(e.decisor_nombre || "").split(/\s+/)[0] + ",'>\", \"ganchos\": [\"<5 a 6 PRIMERAS FRASES completas y distintas (máx ~22 palabras c/u), VARIANDO la forma: 1-2 'I saw [dato] — [reacción]'; UNA directa al puesto sin dato (solo interés genuino por el rol en esa empresa); una del problema que resuelven; una de cómo trabajan. Máximo dos con la misma coletilla final. Inglés natural, sin plata, de la más fuerte a la más floja>\"]}",
    ].filter(Boolean).join("\n");
    let out = "";
    try {
      const child = execFileP("claude", ["-p", "--dangerously-skip-permissions"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 10, timeout: 1000 * 60 * 10, shell: WIN });
      child.child.stdin.end(partes); out = (await child).stdout || "";
    } catch (err) { console.error("  Regenerar falló: " + String(err.message).slice(0, 160)); await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ regenerar: false }) }); continue; }
    let cuerpo = "", ganchos = null;
    const jm = out.match(/\{[\s\S]*\}/);
    if (jm) { try { const o = JSON.parse(jm[0]); cuerpo = String(o.mail || "").trim(); if (Array.isArray(o.ganchos)) ganchos = o.ganchos.map(x => String(x).trim()).filter(Boolean).slice(0, 6).join("\n"); } catch {} }
    if (!cuerpo) cuerpo = out.replace(/^```[a-z]*\n?|\n?```$/g, "").trim();  // fallback: texto plano
    if (cuerpo && /\bhi\b/i.test(cuerpo.slice(0, 40))) {
      const patch = { mail_cuerpo: cuerpo, regenerar: false, instruccion_mail: null, qa_estado: null, qa_nota: null, status: e.status === "programado" ? "nuevo" : e.status, programado_para: null, updated_at: new Date().toISOString() };
      if (ganchos) patch.ganchos = ganchos;
      await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify(patch) });
      console.log("  ✓ Mail regenerado: " + e.empresa + (ganchos ? " (+ganchos)" : ""));
    } else { await api("empleos?id=eq." + e.id, { method: "PATCH", body: JSON.stringify({ regenerar: false }) }); console.error("  Regenerar: salida vacía para " + e.empresa); }
  }
}

async function tick() {
  await refuerzosApollo();
  try { await regenerarMails(); } catch (e) { console.error("  Regenerar: " + String(e.message).slice(0, 160)); }
  const perfiles = (await api("perfiles_empleo?activo=eq.true&select=*")) || [];
  for (const p of perfiles) { const m = tocaHoy(p); if (m) await correr(p, m); }
  for (const p of perfiles) { if (p.auto_envio) { try { await controlCalidad(p); } catch (e) { console.error("  Control: " + String(e.message).slice(0, 160)); } } }
  try { await enviarProgramados(); } catch (e) { console.error("  Envío: " + String(e.message).slice(0, 160)); }
  try { await revisarRespuestas(); } catch (e) { console.error("  Respuestas: " + String(e.message).slice(0, 160)); }
}

const VIGILAR = process.argv.includes("--vigilar");
console.log("MOTOR DE EMPLEO" + (APOLLO ? " · Apollo conectado" : " · sin Apollo") + (MAIL_USER ? " · Gmail " + MAIL_USER : " · Gmail NO configurado (sin envío automático ni respuestas)") + " · busca dom-vie a las " + HORA + ":00 · hasta " + CANTIDAD + " por corrida · envía lun-vie");
if (!VIGILAR) {
  const perfiles = (await api("perfiles_empleo?activo=eq.true&select=*")) || [];
  if (!perfiles.length) console.log("No hay perfiles activos. Creá uno en el panel (EMPLEO → Perfiles).");
  await refuerzosApollo();
  for (const p of perfiles) await correr(p, "pasada manual");
} else {
  console.log("Modo vigilancia: dejá esta ventana abierta. Reviso el panel cada 12s (pedidos de 'Buscar ahora' y la corrida diaria).");
  for (;;) { try { await tick(); } catch (e) { console.error("Error: " + String(e.message).slice(0, 200)); } await new Promise(r => setTimeout(r, 12000)); }
}
