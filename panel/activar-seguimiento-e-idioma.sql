-- ============================================================
-- ACTIVAR: Seguimiento (cadencia + "Para hoy" + cierre + toques)  +  Idioma del lead (ES/EN)
-- Correr UNA vez en Supabase → SQL Editor → Run. Seguro de repetir.
-- ============================================================

-- ===== SEGUIMIENTO ==========================================
-- 1) Columnas de seguimiento en leads
alter table public.leads add column if not exists cadencia_paso      integer     not null default 0;
alter table public.leads add column if not exists next_action_at     timestamptz;
alter table public.leads add column if not exists next_action_tipo   text;
alter table public.leads add column if not exists seguimiento_activo boolean     not null default true;

-- 2) Campos de cierre (para el análisis)
alter table public.leads add column if not exists cierre_motivo  text;
alter table public.leads add column if not exists cierre_falto   text;
alter table public.leads add column if not exists cierre_obs     text;

-- 3) Tabla de toques (línea de tiempo: mails + llamadas + notas)
create table if not exists public.touches (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references public.leads(id) on delete cascade,
  tipo       text not null,
  resultado  text,
  texto      text,
  created_at timestamptz not null default now()
);
create index if not exists touches_lead_idx on public.touches(lead_id, created_at desc);

alter table public.touches enable row level security;
drop policy if exists touches_admin_all on public.touches;
create policy touches_admin_all on public.touches
  for all using (public.is_admin()) with check (public.is_admin());

-- 4) Realtime (si ya está agregada, ignorá el aviso)
do $$ begin
  alter publication supabase_realtime add table public.touches;
exception when duplicate_object then null; end $$;

-- ===== IDIOMA ===============================================
alter table public.leads add column if not exists idioma text;   -- 'es' | 'en' (null = se detecta solo)

-- Listo. Prende: pestaña PARA HOY, cadencia, registrar llamadas, Ganado/Perdido y el chip ES/EN.
