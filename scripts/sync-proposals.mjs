// Sube cada propuesta de /proposals al panel (Supabase): registro + PDF.
// Corre dentro de GitHub Actions. Idempotente: por number, actualiza si existe.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function rest(path, opts = {}) {
  const res = await fetch(URL + '/rest/v1/' + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const txt = await res.text();
  if (!res.ok) throw new Error(path + ' -> ' + res.status + ' ' + txt);
  return txt ? JSON.parse(txt) : null;
}

async function upsertClient(name, contact) {
  if (!name) return null;
  const found = await rest('clients?select=id&name=eq.' + encodeURIComponent(name) + '&limit=1');
  if (found && found.length) return found[0].id;
  const created = await rest('clients', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name, contact: contact || null })
  });
  return created[0].id;
}

async function uploadPdf(localPath, destName) {
  const buf = readFileSync(localPath);
  const res = await fetch(URL + '/storage/v1/object/proposals/' + encodeURIComponent(destName), {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: buf
  });
  if (!res.ok) { throw new Error('upload ' + destName + ' -> ' + res.status + ' ' + (await res.text())); }
  return URL + '/storage/v1/object/public/proposals/' + encodeURIComponent(destName);
}

async function upsertProposal(p, clientId, fileUrl, fileName) {
  const row = {
    number: p.number, client_id: clientId,
    client_free: (p.client_name && !clientId) ? p.client_name : null,
    title: p.title, amount: p.amount, status: p.status || 'enviada',
    date: p.date || null, notes: p.notes || null,
    file_url: fileUrl || null, file_name: fileName || null,
    updated_at: new Date().toISOString()
  };
  const found = await rest('proposals?select=id&number=eq.' + encodeURIComponent(p.number) + '&limit=1');
  if (found && found.length) {
    await rest('proposals?id=eq.' + found[0].id, { method: 'PATCH', body: JSON.stringify(row) });
    console.log('· actualizada', p.number);
  } else {
    row.created_at = new Date().toISOString();
    await rest('proposals', { method: 'POST', body: JSON.stringify(row) });
    console.log('· creada', p.number);
  }
}

const dir = 'proposals';
const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
if (!files.length) { console.log('No hay propuestas para sincronizar.'); process.exit(0); }

for (const f of files) {
  const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const clientId = await upsertClient(p.client_name, p.client_contact);
  let fileUrl = null, fileName = null;
  if (p.pdf && existsSync(join(dir, p.pdf))) {
    fileName = p.number + '.pdf';
    fileUrl = await uploadPdf(join(dir, p.pdf), fileName);
  }
  await upsertProposal(p, clientId, fileUrl, fileName);
}
console.log('Listo:', files.length, 'propuesta(s) sincronizada(s).');
