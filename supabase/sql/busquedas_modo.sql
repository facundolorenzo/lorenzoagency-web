-- Agente 4: modo de búsqueda ('nicho' = varios por rubro | 'especifico' = un lugar por su nombre)
alter table busquedas add column if not exists modo text default 'nicho';
