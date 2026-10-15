-- ============================================================
-- Migración: Seguimiento (cadencia + "Para hoy" + cierre + toques)
-- Correr UNA vez en Supabase → SQL Editor. Seguro de repetir.
-- ============================================================

-- 1) Columnas de seguimiento en leads --------------------------------
alter table public.leads add column if not exists cadencia_paso      integer     not null default 0;   -- en qué toque de la cadencia va
alter table public.leads add column if not exists next_action_at     timestamptz;                      -- cuándo toca el próximo toque
alter table public.leads add column if not exists next_action_tipo   text;                             -- 'mail' | 'llamada'
alter table public.leads add column if not exists seguimiento_activo boolean     not null default true;-- false cuando respondió/ganó/perdió

-- 2) Campos de cierre (para el análisis) -----------------------------
alter table public.leads add column if not exists cierre_motivo  text;   -- precio / timing / eligió a otro / desapareció / otro  (o 'ganado')
alter table public.leads add column if not exists cierre_falto   text;   -- qué faltó
alter table public.leads add column if not exists cierre_obs     text;   -- observación libre

-- 3) Tabla de toques (línea de tiempo: mails + llamadas + notas) -----
create table if not exists public.touches (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references public.leads(id) on delete cascade,
  tipo       text not null,          -- 'mail' | 'llamada' | 'nota'
  resultado  text,                   -- para llamadas: atendio_interesado / atendio_frio / no_atendio / mensaje / agendo
  texto      text,                   -- cuerpo del mail enviado, o nota de la llamada
  created_at timestamptz not null default now()
);
create index if not exists touches_lead_idx on public.touches(lead_id, created_at desc);

alter table public.touches enable row level security;
drop policy if exists touches_admin_all on public.touches;
create policy touches_admin_all on public.touches
  for all using (public.is_admin()) with check (public.is_admin());

-- 4) Realtime --------------------------------------------------------
alter publication supabase_realtime add table public.touches;

-- Listo.
