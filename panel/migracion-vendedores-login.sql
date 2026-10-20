-- ============================================================
-- Migración: LOGIN DE VENDEDORES + permisos (RLS)
-- Correr UNA vez en Supabase → SQL Editor → Run. Seguro de repetir.
-- Requiere que YA se haya corrido migracion-comisiones.sql.
-- ============================================================
-- Cada vendedor entra al panel con su email y ve SOLO lo suyo:
-- sus clientes (leads asignados), su comisión y el ranking.
-- NO ve propuestas, facturas, clientes, captación ni los leads de otros.
-- ============================================================

-- 1) Email del vendedor (vincula su cuenta de acceso) -----------------
alter table public.vendedores add column if not exists email text;
create unique index if not exists vendedores_email_uidx
  on public.vendedores (lower(email)) where email is not null;

-- 2) Identidad del vendedor logueado ---------------------------------
-- Devuelve el id del vendedor cuyo email coincide con el del usuario logueado.
create or replace function public.mi_vendedor_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.vendedores
  where email is not null
    and lower(email) = lower(auth.jwt() ->> 'email')
    and activo
  limit 1;
$$;

create or replace function public.es_vendedor()
returns boolean language sql stable security definer set search_path = public as $$
  select public.mi_vendedor_id() is not null;
$$;

-- 3) LEADS: el vendedor ve y edita SOLO los suyos (admin ve todo) -----
drop policy if exists "leads_read" on public.leads;
create policy "leads_read" on public.leads for select
  using (public.is_admin() or vendedor_id = public.mi_vendedor_id());

drop policy if exists "leads_update" on public.leads;
create policy "leads_update" on public.leads for update
  using (public.is_admin() or vendedor_id = public.mi_vendedor_id())
  with check (public.is_admin() or vendedor_id = public.mi_vendedor_id());
-- insert sigue abierto (form del sitio) y delete sigue admin-only.

-- 4) TOUCHES (mails/llamadas/notas): el vendedor, solo las de sus leads -
drop policy if exists touches_admin_all on public.touches;
drop policy if exists "touches_sel" on public.touches;
drop policy if exists "touches_ins" on public.touches;
drop policy if exists "touches_mod" on public.touches;
drop policy if exists "touches_del" on public.touches;
create policy "touches_sel" on public.touches for select
  using (public.is_admin() or lead_id in (select id from public.leads where vendedor_id = public.mi_vendedor_id()));
create policy "touches_ins" on public.touches for insert
  with check (public.is_admin() or lead_id in (select id from public.leads where vendedor_id = public.mi_vendedor_id()));
create policy "touches_mod" on public.touches for update using (public.is_admin()) with check (public.is_admin());
create policy "touches_del" on public.touches for delete using (public.is_admin());

-- 5) VENDEDORES: el vendedor ve su propia fila; admin administra todo ---
drop policy if exists "vendedores_admin_all" on public.vendedores;
create policy "vendedores_admin_all" on public.vendedores
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "vendedores_self" on public.vendedores;
create policy "vendedores_self" on public.vendedores for select
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- 6) CERRAR AGUJEROS: el vendedor NO debe ver propuestas ni captación ---
-- Propuestas: el admin ve todo; un authenticated que NO es vendedor
-- mantiene el acceso de antes (rol cliente/socio); el vendedor queda afuera.
drop policy if exists "proposals_read" on public.proposals;
create policy "proposals_read" on public.proposals for select
  using (public.is_admin() or (auth.role() = 'authenticated' and not public.es_vendedor()));

-- Captación (prospectos): pasa a admin-only (antes la veía cualquier logueado).
drop policy if exists "prospectos_auth" on public.prospectos;
drop policy if exists "prospectos_admin" on public.prospectos;
create policy "prospectos_admin" on public.prospectos
  for all using (public.is_admin()) with check (public.is_admin());

-- 7) RANKING público (sin comisiones ni leads ajenos) -----------------
-- El vendedor llama a esta función para ver el ranking del mes; devuelve
-- sólo nombre + vendido + ventas por vendedor, nunca comisiones ni detalle.
create or replace function public.ranking_mes(mes text)
returns table(vendedor_id uuid, nombre text, volumen numeric, ventas bigint)
language sql stable security definer set search_path = public as $$
  select v.id, v.nombre,
         coalesce(sum(l.monto_venta), 0)::numeric as volumen,
         count(l.id) as ventas
  from public.vendedores v
  left join public.leads l
    on l.vendedor_id = v.id
    and l.status = 'ganado'
    and l.monto_venta > 0
    and to_char(coalesce(l.fecha_cierre, l.created_at), 'YYYY-MM') = mes
  where v.activo
  group by v.id, v.nombre
  order by volumen desc;
$$;
grant execute on function public.ranking_mes(text) to authenticated;

-- Listo. Ahora creá la cuenta de cada vendedor en
-- Authentication → Users (mismo email que cargaste en la tabla vendedores).
