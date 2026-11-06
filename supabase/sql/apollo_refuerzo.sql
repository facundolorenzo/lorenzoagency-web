-- Refuerzo Apollo por negocio (botón ⚡ del panel)
alter table prospectos add column if not exists apollo_estado text;      -- 'pendiente' | 'hecho' | 'sin_resultado'
alter table prospectos add column if not exists apollo_nota text;
alter table prospectos add column if not exists apollo_at timestamptz;
