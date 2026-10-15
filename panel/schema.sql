-- =====================================================================
-- LORENZO AGENCY · Panel interno — Supabase schema
-- Pegá TODO esto en Supabase → SQL Editor → Run.
-- IMPORTANTE: cambiá 'TU-EMAIL@ACA.COM' (abajo del todo) por el email
-- con el que vas a entrar al panel, ANTES de ejecutar.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Quién es admin (acceso total) ----------
create table if not exists public.admins (
  email text primary key
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- ---------- Clientes ----------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  contact text,
  email text,
  phone text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- Propuestas (LA-AAAA-NNN) ----------
create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  client_id uuid references public.clients(id) on delete set null,
  client_free text,
  title text not null,
  amount numeric default 0,
  status text default 'borrador',
  date date,
  notes text,
  file_url text,
  file_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- Facturas (INV-AAAA-NNN) ----------
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  client_id uuid references public.clients(id) on delete set null,
  amount numeric default 0,
  status text default 'pendiente',
  issued date,
  due date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- Settings (objetivo mensual) ----------
create table if not exists public.settings (
  key text primary key,
  monthly_goal numeric default 0,
  updated_at timestamptz default now()
);

-- ---------- Leads (del formulario del sitio) ----------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  phone text,
  service text,
  message text,
  source text default 'website',
  status text default 'nuevo',
  created_at timestamptz default now()
);

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.admins    enable row level security;
alter table public.clients   enable row level security;
alter table public.proposals enable row level security;
alter table public.invoices  enable row level security;
alter table public.settings  enable row level security;
alter table public.leads     enable row level security;

-- admins: solo admin lee la lista
drop policy if exists "admins_read" on public.admins;
create policy "admins_read" on public.admins for select using (public.is_admin());

-- clients: solo admin
drop policy if exists "clients_all" on public.clients;
create policy "clients_all" on public.clients for all using (public.is_admin()) with check (public.is_admin());

-- proposals: cualquier usuario logueado LEE; solo admin escribe
drop policy if exists "proposals_read" on public.proposals;
create policy "proposals_read" on public.proposals for select using (auth.role() = 'authenticated');
drop policy if exists "proposals_insert" on public.proposals;
create policy "proposals_insert" on public.proposals for insert with check (public.is_admin());
drop policy if exists "proposals_update" on public.proposals;
create policy "proposals_update" on public.proposals for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "proposals_delete" on public.proposals;
create policy "proposals_delete" on public.proposals for delete using (public.is_admin());

-- invoices: solo admin
drop policy if exists "invoices_all" on public.invoices;
create policy "invoices_all" on public.invoices for all using (public.is_admin()) with check (public.is_admin());

-- settings: solo admin
drop policy if exists "settings_all" on public.settings;
create policy "settings_all" on public.settings for all using (public.is_admin()) with check (public.is_admin());

-- leads: cualquiera (el form del sitio, anónimo) puede INSERTAR; solo admin lee/edita
drop policy if exists "leads_insert" on public.leads;
create policy "leads_insert" on public.leads for insert with check (true);
drop policy if exists "leads_read" on public.leads;
create policy "leads_read" on public.leads for select using (public.is_admin());
drop policy if exists "leads_update" on public.leads;
create policy "leads_update" on public.leads for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "leads_delete" on public.leads;
create policy "leads_delete" on public.leads for delete using (public.is_admin());

-- fila inicial del objetivo
insert into public.settings (key, monthly_goal) values ('goal', 0)
  on conflict (key) do nothing;

-- ---------- Storage: bucket para los PDF de propuestas ----------
insert into storage.buckets (id, name, public) values ('proposals','proposals', true)
  on conflict (id) do nothing;

drop policy if exists "proposals_pdf_read" on storage.objects;
create policy "proposals_pdf_read" on storage.objects for select using (bucket_id = 'proposals');
drop policy if exists "proposals_pdf_upload" on storage.objects;
create policy "proposals_pdf_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'proposals' and public.is_admin());
drop policy if exists "proposals_pdf_delete" on storage.objects;
create policy "proposals_pdf_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'proposals' and public.is_admin());

-- ---------- Realtime (sincroniza entre dispositivos en vivo) ----------
do $$ begin
  alter publication supabase_realtime add table public.proposals;
  alter publication supabase_realtime add table public.invoices;
  alter publication supabase_realtime add table public.clients;
  alter publication supabase_realtime add table public.settings;
  alter publication supabase_realtime add table public.leads;
exception when duplicate_object then null; end $$;

-- =====================================================================
-- ÚLTIMO PASO: ponete como admin. Cambiá el email por el tuyo.
-- =====================================================================
insert into public.admins (email) values ('facundoluislorenzo@gmail.com')
  on conflict (email) do nothing;
