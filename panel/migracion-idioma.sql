-- ============================================================
-- Migración: idioma del lead (ES / EN) para ruteo
--   español -> lo llama Facu   ·   inglés -> closer con comisión
-- Correr UNA vez en Supabase → SQL Editor. Seguro de repetir.
-- ============================================================

alter table public.leads add column if not exists idioma text;   -- 'es' | 'en' (null = se detecta solo en el panel)

-- Listo. El panel detecta el idioma por el mensaje; vos lo podés corregir tocando el chip.
