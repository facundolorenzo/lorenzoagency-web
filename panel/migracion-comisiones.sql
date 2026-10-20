-- ============================================================
-- Migración: Comisiones de vendedores
-- Correr UNA vez en Supabase → SQL Editor → Run. Seguro de repetir.
-- ============================================================
-- Sistema: escalera por volumen MENSUAL (se resetea cada mes).
-- La comisión es 100% INTERNA (va metida en el precio; el cliente no la ve).
-- El cálculo de la escalera y la corona vive en el panel (index.html),
-- acá sólo guardamos los datos crudos: quién cerró, cuánto, y cuándo.
-- ============================================================

-- 1) Tabla de vendedores -------------------------------------------
create table if not exists public.vendedores (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.vendedores enable row level security;
drop policy if exists "vendedores_admin_all" on public.vendedores;
create policy "vendedores_admin_all" on public.vendedores
  for all using (public.is_admin()) with check (public.is_admin());

-- 2) Datos de venta en cada lead -----------------------------------
--    vendedor_id  = quién cerró el deal (null = sin asignar)
--    monto_venta  = lo que pagó el cliente en ese cierre (total, USD)
--    fecha_cierre = cuándo se marcó Ganado (define a qué MES cuenta)
alter table public.leads add column if not exists vendedor_id  uuid references public.vendedores(id) on delete set null;
alter table public.leads add column if not exists monto_venta  numeric;
alter table public.leads add column if not exists fecha_cierre timestamptz;

-- 3) Realtime (sincroniza en vivo entre dispositivos) --------------
do $$ begin
  alter publication supabase_realtime add table public.vendedores;
exception when duplicate_object then null; end $$;

-- Listo. El panel ya puede cargar vendedores y calcular comisiones.
