-- Métricas de Instagram para el Agente 2 (módulo Contenido)
-- 1) Columna para unir cada pieza con su post publicado
alter table contenido_piezas add column if not exists ig_media_id text;

-- 2) Tabla de métricas por post
create table if not exists ig_metricas (
  media_id text primary key,
  pieza_id uuid references contenido_piezas(id) on delete set null,
  caption text,
  permalink text,
  publicado_en timestamptz,
  likes int,
  comentarios int,
  alcance int,
  guardados int,
  compartidos int,
  vistas int,
  interacciones int,
  raw jsonb,
  updated_at timestamptz default now()
);

alter table ig_metricas enable row level security;
drop policy if exists "admin todo ig_metricas" on ig_metricas;
create policy "admin todo ig_metricas" on ig_metricas
  for all using (is_admin()) with check (is_admin());
