-- EMPLEO: perfiles de personas que buscan trabajo + empresas encontradas por el motor
-- Correr en: Supabase -> SQL Editor -> New query -> pegar -> Run

create table if not exists public.perfiles_empleo (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  email_envio text,                       -- casilla desde la que salen los mails (Gmail personal)
  cuenta text default 'empleo',           -- qué secrets usa la función enviar: 'empleo' (Gmail) / 'agencia'
  roles text,                             -- "Forward Deployed Engineer · AI Engineer · Full-stack"
  pais text default 'Estados Unidos',
  ubicacion text,                         -- "remoto o Miami"
  modalidad text,                         -- remoto / híbrido / presencial / cualquiera
  salario_min integer,                    -- en miles de USD/año (ej. 110)
  etapas text,                            -- "Pre-seed · Seed · Serie A"
  contrato text,                          -- "W2 o 1099 · fraccional OK"
  experiencia text,                       -- resumen de experiencia
  distinto text,                          -- "lo que me hace distinto"
  proyectos text,                         -- "Cronos · agentes; Priztine · app members; ..."
  linkedin text,
  cv_url text, cv_nombre text,
  presskit_url text, presskit_nombre text,
  mail_asunto text,                       -- plantilla; admite {empresa} {rol} {nombre}
  mail_base text,                         -- plantilla; admite {nombre} {empresa} {rol} {gancho}
  activo boolean default true,
  pedido_busqueda boolean default false,  -- el panel lo pone en true con "Buscar ahora"; el motor lo baja
  estado_motor text,                      -- buscando / lista / error
  ultima_corrida timestamptz,
  ultima_revisadas integer,
  ultima_nuevas integer,
  created_at timestamptz default now(),
  updated_at timestamptz
);
alter table public.perfiles_empleo enable row level security;
drop policy if exists "perfiles_empleo_auth" on public.perfiles_empleo;
create policy "perfiles_empleo_auth" on public.perfiles_empleo
  for all to authenticated using (true) with check (true);

create table if not exists public.empleos (
  id uuid primary key default gen_random_uuid(),
  perfil_id uuid references public.perfiles_empleo(id) on delete cascade,
  empresa text not null,
  web text,
  ciudad text,
  tamano text,                            -- "13 personas"
  etapa text,                             -- Pre-seed / Seed / Serie A / Serie B+ / Bootstrapped
  rol text,                               -- puesto que buscan
  salario text,                           -- "$130k – 160k" (texto, como lo publiquen)
  modalidad text,                         -- Remoto / Híbrido Miami / Presencial NY
  fuente text,                            -- "Greenhouse / Crunchbase / web"
  url_aviso text,
  publicado text,                         -- fecha del aviso si se sabe
  senal text,                             -- "levantó $4M hace 40 días"
  descripcion text,                       -- qué hace la empresa (2 líneas)
  decisor_nombre text,
  decisor_cargo text,
  decisor_email text,
  decisor_email_verificado boolean default false,
  decisor_linkedin text,
  match integer,                          -- 0-100 % de chance
  por_que text,                           -- por qué encaja + por dónde entrar
  mail_asunto text,
  mail_cuerpo text,                       -- redactado por el motor, listo para enviar
  status text default 'nuevo',            -- nuevo / enviado / respondio / descartado
  apollo_estado text,                     -- pendiente / hecho / sin_resultado
  apollo_nota text,
  enviado_at timestamptz,
  respondio_at timestamptz,
  feedback text,                          -- ok / no (aprendizaje del motor)
  notas text,
  created_at timestamptz default now(),
  updated_at timestamptz
);
alter table public.empleos enable row level security;
drop policy if exists "empleos_auth" on public.empleos;
create policy "empleos_auth" on public.empleos
  for all to authenticated using (true) with check (true);
create index if not exists empleos_perfil_idx on public.empleos(perfil_id, status);

-- Bucket público para CV y presskit de cada perfil
insert into storage.buckets (id, name, public) values ('empleo','empleo', true)
  on conflict (id) do update set public = true;
drop policy if exists "empleo_read" on storage.objects;
create policy "empleo_read" on storage.objects for select to public using (bucket_id = 'empleo');
drop policy if exists "empleo_write" on storage.objects;
create policy "empleo_write" on storage.objects for insert to authenticated with check (bucket_id = 'empleo');
drop policy if exists "empleo_update" on storage.objects;
create policy "empleo_update" on storage.objects for update to authenticated using (bucket_id = 'empleo');

-- v2: motivación (dos carriles)
alter table public.perfiles_empleo add column if not exists intereses text;   -- sectores/temas que lo motivan
alter table public.perfiles_empleo add column if not exists evitar text;      -- sectores que no lo motivan
alter table public.perfiles_empleo add column if not exists tope_diario integer default 5;
alter table public.empleos add column if not exists motivacion integer;       -- 0-100 cuánto encaja con lo que le gusta
alter table public.empleos add column if not exists carril text;              -- 'remoto' (plata+remoto) / 'motiva' (crecimiento/interés) / 'ambos'
alter table public.perfiles_empleo add column if not exists ciudades_extra text; -- otras ciudades donde se mudaría

-- v3: piloto automático
alter table public.perfiles_empleo add column if not exists auto_envio boolean default false;
alter table public.perfiles_empleo add column if not exists hora_envio integer default 8;
alter table public.empleos add column if not exists qa_estado text;          -- ok / revisar
alter table public.empleos add column if not exists qa_nota text;
alter table public.empleos add column if not exists programado_para timestamptz;
alter table public.empleos add column if not exists visto boolean default true;
