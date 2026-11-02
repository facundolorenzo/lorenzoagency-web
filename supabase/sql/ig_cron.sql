-- Timer de Instagram: publica las programadas y renueva el token solo.
-- IMPORTANTE: antes de correr, reemplazá TU_SERVICE_ROLE_KEY por tu service role key
-- (Supabase -> Project Settings -> API keys -> service_role).

-- 1) Extensiones necesarias
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Tabla donde vive el token vigente de Instagram (lo maneja el sistema)
create table if not exists ig_tokens (
  id int primary key default 1,
  access_token text not null,
  updated_at timestamptz default now()
);
alter table ig_tokens enable row level security;
-- Sin policies: solo el service_role (las funciones) puede leerla/escribirla.

-- 3) Timer: cada 5 minutos llama a ig-cron (publica programadas + renueva token)
select cron.schedule(
  'ig-cron-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://noxvfulftytfizzaunln.supabase.co/functions/v1/ig-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer TU_SERVICE_ROLE_KEY'
    ),
    body := '{}'::jsonb
  );
  $$
);
