-- AGENTE 4 (Prospección / outbound): base de prospectos
-- Correr en: Supabase -> SQL Editor -> New query -> pegar -> Run
create table if not exists public.prospectos (
  id uuid primary key default gen_random_uuid(),
  empresa text not null,
  contacto text,
  email text,
  phone text,
  web text,
  instagram text,
  nicho text,                         -- venue / restaurante / lounge / otro
  ciudad text,
  fuente text,                        -- Google / Instagram / Sunbiz / import / manual
  notas text,
  status text default 'encontrado',   -- encontrado / contactable / enviado / respondio / descartado
  borrador text,                      -- propuesta redactada por el agente (capa 3)
  lead_id uuid references public.leads(id) on delete set null,  -- si pasó a Leads
  espacio_id text,                    -- multiusuario futuro (misma regla que Cronos)
  created_at timestamptz default now(),
  updated_at timestamptz
);
alter table public.prospectos enable row level security;
drop policy if exists "prospectos_auth" on public.prospectos;
create policy "prospectos_auth" on public.prospectos
  for all to authenticated using (true) with check (true);
