"""Contrato de datos de Vigilia. Cualquier cambio aquí se acuerda entre los dos."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Veredicto = Literal["VALIDA", "VALIDA_CON_ALERTAS", "NO_VALIDA", "NO_ENCONTRADO", "PENDIENTE"]
Alerta = Literal["BAJO", "MEDIO", "ALTO"]
EstadoFuente = Literal["not_configured", "connected", "unavailable", "invalid_response", "not_found"]


class EventoIngreso(BaseModel):
    """Lo que envía el hospital al webhook cuando un asegurado ingresa a emergencias."""

    evento_id: str = Field(..., max_length=40, examples=["ING-0001"])
    cedula: str = Field(..., max_length=20, examples=["8-400-400"])
    hospital: str = Field(..., max_length=80, examples=["Hospital Punta Pacífica"])
    motivo_ingreso: str = Field(..., min_length=3, max_length=300, examples=["Dolor torácico opresivo"])
    triage: int | None = Field(None, ge=1, le=5, description="1 = más grave")
    fecha_ingreso: datetime


class PolizaInfo(BaseModel):
    numero: str
    plan: str
    vigente: bool
    al_dia_pago: bool
    en_carencia: bool


class PreexistenciaRelacionada(BaseModel):
    condicion: str
    relacion: Literal["DIRECTA", "POSIBLE", "NINGUNA"]
    justificacion: str
    relacion_sugerida: Literal["DIRECTA", "POSIBLE", "NINGUNA"] | None = None
    revisada: bool = False
    motivo_revision: str | None = None
    revisor_id: str | None = None
    revisada_en: datetime | None = None


class EstadoIntegracion(BaseModel):
    tipo: str
    estado: EstadoFuente
    consultada: bool = False
    revisada_en: datetime | None = None


class Mensajes(BaseModel):
    admisiones: str
    gestor: str


class Notificacion(BaseModel):
    destino: Literal["admisiones", "gestor_casos"]
    canal: str
    estado: Literal["ENVIADA", "ERROR", "NO_CONFIGURADA"]


class RespuestaIngreso(BaseModel):
    """Lo que devuelve el webhook."""

    evento_id: str
    veredicto: Veredicto
    nivel_alerta: Alerta
    poliza: PolizaInfo | None
    preexistencias: list[PreexistenciaRelacionada]
    mensaje_admisiones: str
    mensaje_gestor: str
    notificaciones: list[Notificacion]
    fuentes: list[EstadoIntegracion] = Field(default_factory=list)
