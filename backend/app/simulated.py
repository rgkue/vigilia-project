"""Sistemas externos simulados para la instalación de muestra en modo producción.

Un hospital o aseguradora real conecta sus propias APIs desde Administración → Integraciones.
Para que el jurado vea ese flujo completo sin depender de terceros, este módulo expone, solo con
``VIGILIA_SIMULATED_SYSTEMS=true``, una aseguradora ficticia (cobertura y antecedentes con su propio
formato JSON) y dos receptores de avisos que reenvían el mensaje a Slack. Los datos son los mismos
asegurados ficticios del modo demo.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request

from .seed import ASEGURADOS, POLIZAS, PREEXISTENCIAS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/simulado", tags=["sistemas simulados"])

DESTINOS = {"admisiones": "SLACK_WEBHOOK_ADMISIONES", "gestor": "SLACK_WEBHOOK_GESTOR"}


def enabled() -> bool:
    return (os.getenv("VIGILIA_SIMULATED_SYSTEMS") or "false").strip().casefold() == "true"


def base_url() -> str | None:
    """URL HTTPS pública de estos endpoints; en Vercel se deduce del dominio de producción."""
    configured = (os.getenv("VIGILIA_SIMULATED_BASE_URL") or "").strip().rstrip("/")
    if not configured:
        host = (os.getenv("VERCEL_PROJECT_PRODUCTION_URL") or "").strip().strip("/")
        configured = f"https://{host}/api/simulado" if host else ""
    parts = urlsplit(configured)
    # HTTPS siempre, salvo pruebas locales contra el propio equipo.
    local = parts.scheme == "http" and parts.hostname in {"127.0.0.1", "localhost"}
    if (parts.scheme != "https" and not local) or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        return None
    return configured


def site_url() -> str | None:
    """Origen público de la instalación (sin /api/simulado)."""
    base = base_url()
    if not base:
        return None
    parts = urlsplit(base)
    return f"{parts.scheme}://{parts.netloc}"


def shared_secret() -> str:
    """Credencial Bearer entre Vigilia y los sistemas simulados, derivada del secreto de sesión."""
    key = (os.getenv("VIGILIA_SESSION_SECRET") or "vigilia-demo-session-secret-not-for-production").encode()
    return hmac.new(key, b"vigilia:sistemas-simulados", hashlib.sha256).hexdigest()


def _authorize(request: Request) -> None:
    if not enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    supplied = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    if not supplied or not hmac.compare_digest(supplied.encode(), shared_secret().encode()):
        raise HTTPException(status_code=401, detail="Credencial del sistema simulado inválida.")


def _insured(cedula: str) -> str | None:
    return next((name for document, name in ASEGURADOS if document == cedula), None)


@router.get("/aseguradora/cobertura")
def coverage(cedula: str, request: Request) -> dict[str, Any] | None:
    """Formato propio de la aseguradora; Vigilia lo traduce con el mapeo de la integración."""
    _authorize(request)
    name = _insured(cedula)
    policy = next((row for row in POLIZAS if row[1] == cedula), None)
    if not name or not policy:
        return None  # JSON null: la aseguradora respondió y el asegurado no existe.
    numero, _, plan, desde, hasta, estado_pago, carencia = policy
    return {
        "asegurado": {"documento": cedula, "nombre": name},
        "poliza": {
            "numero": numero,
            "producto": plan,
            "vigencia": {"inicio": desde, "fin": hasta},
            "estado_pago": estado_pago,
            "carencia_dias": carencia,
        },
    }


@router.get("/aseguradora/antecedentes")
def history(cedula: str, request: Request) -> dict[str, Any]:
    _authorize(request)
    records = [{"diagnostico": condition, "fecha": date} for document, condition, date in PREEXISTENCIAS if document == cedula]
    return {"documento": cedula, "registros": records}


@router.post("/avisos/{destino}")
async def notice(destino: str, request: Request) -> dict[str, Any]:
    """Receptor de avisos del hospital (admisiones) o de la aseguradora (gestor de casos)."""
    _authorize(request)
    if destino not in DESTINOS:
        raise HTTPException(status_code=404, detail="Destino desconocido.")
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    message = payload.get("message") if isinstance(payload, dict) else None
    if not isinstance(message, str) or not message.strip():
        # "Probar conexión" desde Administración envía una consulta sin aviso.
        return {"recibido": True, "prueba": True}
    url = os.getenv(DESTINOS[destino])
    if (os.getenv("SLACK_ENABLED") or "false").strip().casefold() != "true" or not url:
        logger.info("Aviso simulado recibido para %s sin Slack configurado.", destino)
        return {"recibido": True, "reenviado_a": "registro"}
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=False) as client:
            (await client.post(url, json={"text": "Producción · " + message.strip()[:1500]})).raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning("El receptor simulado no pudo reenviar a Slack (%s).", type(exc).__name__)
        raise HTTPException(status_code=502, detail="El receptor no pudo entregar el aviso.") from exc
    return {"recibido": True, "reenviado_a": "slack"}


def integration_specs() -> list[dict[str, Any]]:
    """Integraciones que conectan la instalación de producción con los sistemas simulados."""
    base, site = base_url(), site_url()
    if not base or not site:
        return []
    return [
        {
            "id": "sim-ingreso-his", "kind": "ingress", "name": "HIS del hospital (simulado)",
            "endpoint_url": f"{site}/api/webhook/ingreso", "method": "POST", "lookup_parameter": "cedula",
            "field_map": {
                "evento_id": "$.evento.id", "fecha_ingreso": "$.evento.fecha", "cedula": "$.paciente.cedula",
                "hospital": "$.hospital.nombre", "motivo_ingreso": "$.atencion.motivo", "triage": "$.atencion.triage",
            },
        },
        {
            "id": "sim-cobertura", "kind": "coverage", "name": "Aseguradora · pólizas (simulada)",
            "endpoint_url": f"{base}/aseguradora/cobertura", "method": "GET", "lookup_parameter": "cedula",
            "field_map": {
                "numero": "$.poliza.numero", "plan": "$.poliza.producto", "vigente_desde": "$.poliza.vigencia.inicio",
                "vigente_hasta": "$.poliza.vigencia.fin", "estado_pago": "$.poliza.estado_pago",
                "carencia_dias": "$.poliza.carencia_dias",
            },
        },
        {
            "id": "sim-antecedentes", "kind": "history", "name": "Aseguradora · antecedentes (simulada)",
            "endpoint_url": f"{base}/aseguradora/antecedentes", "method": "GET", "lookup_parameter": "cedula",
            "field_map": {"items": "$.registros", "condition": "diagnostico", "date": "fecha"},
        },
        {
            "id": "sim-avisos-admisiones", "kind": "admissions", "name": "Admisiones del hospital (simulado → Slack)",
            "endpoint_url": f"{base}/avisos/admisiones", "method": "POST", "lookup_parameter": "cedula", "field_map": {},
        },
        {
            "id": "sim-avisos-gestor", "kind": "case_manager", "name": "Gestor de casos de la aseguradora (simulado → Slack)",
            "endpoint_url": f"{base}/avisos/gestor", "method": "POST", "lookup_parameter": "cedula", "field_map": {},
        },
    ]
