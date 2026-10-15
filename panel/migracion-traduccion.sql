-- ============================================================
-- Migración: traducciones al español guardadas (para que SHAI lea por voz sin re-traducir)
-- Correr UNA vez en Supabase → SQL Editor → Run. Seguro de repetir.
-- ============================================================

-- Traducción al español del MENSAJE del lead (la consulta)
alter table public.leads add column if not exists traduccion_es            text;
-- Traducción al español del BORRADOR de respuesta (la respuesta sugerida)
alter table public.leads add column if not exists borrador_traduccion_es   text;
-- Traducción al español de la ÚLTIMA RESPUESTA que mandó el lead
alter table public.leads add column if not exists respuesta_traduccion_es  text;

-- El checker (cada 30 min) las genera y guarda solo para los leads en inglés;
-- para los leads en español, la "traducción" es el mismo texto.
-- Listo.
