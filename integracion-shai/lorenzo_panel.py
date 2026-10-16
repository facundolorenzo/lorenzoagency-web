"""
lorenzo_panel.py — Cliente del panel LORENZO Agency para SHAI.
Lee el estado de ventas del panel (Supabase Edge Function `reporte`) para que
SHAI lo reporte por voz. No piensa ni decide: solo trae datos y los devuelve.

Instalar dependencia (si no está):  pip install httpx
Variables de entorno (en el .env de SHAI):
    LORENZO_PANEL_URL   = https://noxvfulftytfizzaunln.supabase.co
    LORENZO_PANEL_KEY   = (la SERVICE_ROLE_KEY del panel — la MISMA que ya usás en el checker)

Fase 1: SOLO REPORTAR (lectura). Las acciones (responder leads, cambiar estados)
se agregan en una fase 2, aparte.
"""
import os
import httpx

# Cargar el .env aunque se corra el módulo suelto (py -3 -m motor.lorenzo_panel).
# Sin esto, al correr aislado nadie carga el .env y da un 401 "fantasma".
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


def _url() -> str:
    return os.environ.get("LORENZO_PANEL_URL", "https://noxvfulftytfizzaunln.supabase.co").rstrip("/")


def _key() -> str:
    return os.environ.get("LORENZO_PANEL_KEY", "")


# Compatibilidad: constantes a nivel módulo (se leen al importar)
PANEL_URL = _url()
PANEL_KEY = _key()


async def get_reporte() -> dict:
    """
    Trae el estado de ventas del panel.
    Devuelve un dict con, entre otros:
      - resumen_texto: frase lista para leer en voz
      - acciones_para_hoy, totales{nuevos,enviados,respondieron,...}
      - tasa_respuesta, tasa_cierre, idioma{es,en}
      - nuevos_detalle[], calientes[]
    Ante error devuelve {"error": "..."} (SHAI puede leer el error en voz).
    """
    key = _key()
    if not key:
        return {"error": "Falta LORENZO_PANEL_KEY en el .env de SHAI."}
    url = f"{_url()}/functions/v1/reporte"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(url, headers=headers, json={})
            if r.status_code != 200:
                return {"error": f"Panel respondió {r.status_code}: {r.text[:200]}"}
            return r.json()
    except Exception as e:
        return {"error": f"No pude contactar al panel: {e}"}


def resumen_para_voz(data: dict) -> str:
    """Convierte la respuesta del panel en una frase para que SHAI la diga."""
    if data.get("error"):
        return f"No pude leer el panel. {data['error']}"
    return data.get("resumen_texto") or "El panel no devolvió un resumen."


async def _post(func: str, payload: dict) -> dict:
    key = _key()
    if not key:
        return {"error": "Falta LORENZO_PANEL_KEY en el .env de SHAI."}
    url = f"{_url()}/functions/v1/{func}"
    headers = {"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            if r.status_code != 200:
                return {"error": f"{func} respondió {r.status_code}: {r.text[:200]}"}
            return r.json()
    except Exception as e:
        return {"error": f"No pude contactar al panel ({func}): {e}"}


async def responder_preview(lead_id: str, texto_es: str) -> dict:
    """
    PASO 1 — Previsualizar. Tomás tu dictado en español y devuelve el TEXTO FINAL en el
    idioma del lead (si es inglés, lo traduce). SHAI se lo lee a Facu para confirmar. NO manda.
    Devuelve {'idioma': 'en'|'es', 'final': '...'} o {'error': '...'}.
    """
    return await _post("responder", {"lead_id": lead_id, "texto": texto_es, "send": False})


async def responder_enviar(lead_id: str, final: str) -> dict:
    """
    PASO 2 — Enviar. Manda el texto final (ya en el idioma del lead) al lead por email.
    Usar SOLO después de que Facu confirme por voz. Devuelve {'ok': True, 'to': '...'} o {'error': '...'}.
    """
    return await _post("responder", {"lead_id": lead_id, "final": final, "send": True})


# Prueba rápida desde la raíz del proyecto:  py -3 -m motor.lorenzo_panel
# Debe imprimir el resumen de ventas en texto. Si aparece -> SHAI↔LORENZO conectado.
if __name__ == "__main__":
    import asyncio
    data = asyncio.run(get_reporte())
    print(resumen_para_voz(data))
    print(data)
