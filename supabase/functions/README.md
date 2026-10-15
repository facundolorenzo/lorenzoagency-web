# Agente de Venta #1 — despliegue

El panel ya está listo. Para que los botones **Rehacer** y **Enviar** funcionen y para que
detecte respuestas solo, falta desplegar esto con tus keys. Son 3 pasos.

## 1) Correr la migración SQL (una vez)
En Supabase → **SQL Editor** → pegá y ejecutá el archivo `panel/migracion-agente.sql`.
Agrega las columnas nuevas de `leads`, migra los estados viejos al embudo de 6 y crea la tabla
`reply_examples` (aprendizaje).

## 2) Desplegar las funciones `sugerir` y `enviar`
Necesitás la CLI de Supabase (`npm i -g supabase`), logueada en el proyecto `lorenzo-agency`.

Cargar los secrets (una vez):
```
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...        # tu API key de Anthropic
supabase secrets set ANTHROPIC_MODEL=claude-sonnet-5-5   # opcional (default ya es este)
supabase secrets set SMTP_USER=talk@lorenzoagency.tech   # email completo de la compañía
supabase secrets set SMTP_PASS=********                  # contraseña del buzón Private Email
# SMTP_FROM es opcional (default = SMTP_USER)
```
> `SUPABASE_URL` y `SUPABASE_ANON_KEY` ya existen solos dentro de las funciones, no hay que cargarlos.

Desplegar:
```
supabase functions deploy sugerir
supabase functions deploy enviar
```

## 3) Checker de respuestas (GitHub Actions, ya configurado)
Corre solo cada 15 min (`.github/workflows/checker-respuestas.yml`). Solo faltan 2 secrets en GitHub
(Settings → Secrets → Actions):
- `IMAP_USER` = el email completo de la compañía
- `IMAP_PASS` = la contraseña del buzón
(`SUPABASE_SERVICE_ROLE_KEY` ya está cargado del pipeline de propuestas.)

---

### Qué hace cada pieza
- **sugerir** — toma el mensaje del lead + el perfil de LORENZO (`_shared/perfil.ts`) + ejemplos
  aprobados del mismo rubro → pide a Claude un borrador. "Rehacer" = otra versión.
- **enviar** — manda el mail por SMTP desde Private Email, marca el lead `enviado`, suma al
  contador y guarda el par sugerencia→final en `reply_examples` (así aprende).
- **checker** — lee el inbox por IMAP, detecta quién respondió (mueve a `respondio` + sube la
  barra de interés) y pasa a `sin_respuesta` los que llevan +3 días sin contestar.

### Verificación (hacela vos, yo no tengo tus keys)
1. Tras el paso 1, entrá al panel → pestaña LEADS: tiene que verse el embudo (chips) y la barra de interés.
2. Tras el paso 2, abrí un lead → **Rehacer**: debe aparecer un borrador. Editalo → **Enviar**:
   debe llegar el mail y el lead pasar a "Enviados".
3. Cuando esa persona responda, en ≤15 min el lead salta a "Respondieron" y la barra sube.

> Nota técnica a confirmar en el despliegue: el envío SMTP desde Edge Functions usa `denomailer`.
> Si tu proyecto Supabase bloqueara la conexión TCP saliente, el envío se mueve a un GitHub Action
> igual que el checker (mismo patrón). El botón "Copiar email / abrir webmail" queda como respaldo.
