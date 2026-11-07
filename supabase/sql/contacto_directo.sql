-- De quién es el contacto directo (nombre — rol de la persona del email/tel ⭐)
alter table prospectos add column if not exists contacto_directo text;
