-- ============================================================
-- Migración: Agente de Venta #1 (inbound) + embudo de leads
-- Correr UNA vez en Supabase → SQL Editor (proyecto lorenzo-agency).
-- Es seguro de repetir (usa IF NOT EXISTS / IF EXISTS).
-- ============================================================

-- 1) Columnas nuevas en leads -------------------------------------------------
alter table public.leads add column if not exists mails_enviados       integer     not null default 0;
alter table public.leads add column if not exists respuestas_lead       integer     not null default 0;  -- cuántas veces respondió el lead (alimenta la barra de interés)
alter table public.leads add column if not exists fecha_primer_envio    timestamptz;
alter table public.leads add column if not exists fecha_ultimo_envio    timestamptz;
alter table public.leads add column if not exists ultima_respuesta_texto text;
alter table public.leads add column if not exists borrador              text;        -- última respuesta sugerida/editada guardada

-- 2) Migrar estados viejos al embudo de 6 -------------------------------------
-- Antes: nuevo / respondido / cerrado  →  Ahora: nuevo / enviado / respondio / sin_respuesta / ganado / perdido
update public.leads set status='respondio' where status='respondido';
update public.leads set status='ganado'    where status='cerrado';
-- cualquier estado raro vuelve a 'nuevo'
update public.leads set status='nuevo'
  where status is null
     or status not in ('nuevo','enviado','respondio','sin_respuesta','ganado','perdido');

alter table public.leads alter column status set default 'nuevo';

-- 3) Tabla de aprendizaje (ejemplos aprobados = bloque 7) ---------------------
create table if not exists public.reply_examples (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references public.leads(id) on delete set null,
  service    text,                 -- rubro, para segmentar el aprendizaje por nicho
  suggestion text,                 -- lo que propuso el agente
  final      text,                 -- lo que Facu envió de verdad (editado)
  created_at timestamptz not null default now()
);

alter table public.reply_examples enable row level security;

-- Solo el admin puede leer/escribir ejemplos (usa la función is_admin() ya creada en schema.sql)
drop policy if exists reply_examples_admin_all on public.reply_examples;
create policy reply_examples_admin_all on public.reply_examples
  for all using (public.is_admin()) with check (public.is_admin());

-- 4) Realtime (para que la barra/estado se actualicen solos entre dispositivos)
alter publication supabase_realtime add table public.reply_examples;

-- Listo.
