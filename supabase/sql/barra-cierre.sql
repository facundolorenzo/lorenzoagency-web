-- Barra de cierre: avance aprobado + sugerencia pendiente del agente
-- Correr en: Supabase -> SQL Editor -> New query -> pegar -> Run
alter table public.leads add column if not exists cierre_pct   int;    -- avance APROBADO (10/30/55/80; ganado/perdido usan status)
alter table public.leads add column if not exists cierre_freno text;   -- freno aprobado: precio/confianza/claridad/timing/decisión + detalle
alter table public.leads add column if not exists cierre_falta text;   -- la próxima acción que acerca el cierre
alter table public.leads add column if not exists cierre_sug   jsonb;  -- sugerencia PENDIENTE del agente {pct, etapa, freno, falta, fecha}
