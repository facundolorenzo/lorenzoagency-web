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

PANEL_URL = os.environ.get("LORENZO_PANEL_URL", "https://noxvfulftytfizzaunln.supabase.co").rstrip("/")
PANEL_KEY = os.environ.get("LORENZO_PANEL_KEY", "")


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
    if not PANEL_KEY:
        return {"error": "Falta LORENZO_PANEL_KEY en el .env de SHAI."}
    url = f"{PANEL_URL}/functions/v1/reporte"
    headers = {
        "Authorization": f"Bearer {PANEL_KEY}",
        "apikey": PANEL_KEY,
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


# Prueba rápida desde terminal:  python lorenzo_panel.py
if __name__ == "__main__":
    import asyncio
    data = asyncio.run(get_reporte())
    print(resumen_para_voz(data))
    print(data)
