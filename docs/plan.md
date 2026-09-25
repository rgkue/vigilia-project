# Plan de desarrollo de Vigilia

## Objetivo

Entregar una demo pública del reto 4: al recibir un ingreso de emergencia, Vigilia revisa administrativamente la póliza, informa los hallazgos y prepara avisos distintos para admisiones y el gestor de casos. La señal nunca puede retrasar la atención.

## Fecha de entrega

El dashboard interno del equipo indica como plazo el **viernes 25 de septiembre de 2026 a las 21:03, hora de Panamá (UTC−5)**. La prioridad es cerrar el agente y la integración de la demo antes de añadir funciones nuevas.

## Estado actual

- **Frontend en React:** creado desde la raíz del proyecto, con interfaz de vidrio esmerilado, seis escenarios sintéticos alineados con los fixtures, indicador de conexión y sección actualizable de los diez ingresos recientes. Cada entrada del historial abre su respuesta completa. Las clasificaciones del backend se muestran por antecedente usando el mismo tipo interno que Jev; la incertidumbre queda visible como revisión pendiente. Los controles se adaptan a móvil.
- **Jev:** integrado como experimento sintético con AI SDK y como proveedor opcional de FastAPI. Kev sigue predeterminado; Jev solo se elige con `VIGILIA_AI_PROVIDER=jev`, exige `AI_GATEWAY_API_KEY` y ZDR para datos del flujo real, minimiza el estado enviado y falla cerrada si el Gateway rechaza la solicitud. El simulador acepta solo `vig-demo-01` y `vig-demo-04`; las cuatro llamadas recientes pasaron y fueron repetibles con la opción de no entrenamiento. ZDR devolvió 403 con la cuenta actual, por lo que no se debe activar Jev en ingresos reales todavía.
- **Contrato de clasificación de la interfaz:** Jev y las respuestas de FastAPI se normalizan a `condition`, `relation`, `probability`, `explanation`, `source` y `reviewRequired`. `PENDIENTE` es interno de la interfaz; el esquema público conserva `DIRECTA`, `POSIBLE` y `NINGUNA`.
- **Contrato frontend/API:** adaptado a `backend/app/schemas.py` y `backend/docs/contratos.md`; usa `POST /webhook/ingreso`.
- **Sincronización del backend:** El commit remoto `f6c4164` se integró como base. El commit local de sincronización combina el backend Kev predeterminado con Groq explícito y las reglas remotas como pistas optativas. Conserva el contrato público; todas las sugerencias requieren revisión, sin failover automático ni elevación a prioridad alta por una relación directa pendiente. La UI reconoce Jev, Kev y Groq como orígenes distintos.
- **Seguimiento del equipo:** en la última lectura, el dashboard interno mostraba 1 de 11 tareas completadas y mantenía pendientes el agente, las notificaciones, las pruebas y el despliegue. Parte de esas funciones ya aparece en el código de `main`; el tablero y el repositorio no están sincronizados. Usar el código publicado para confirmar comportamiento, y el tablero solo para el seguimiento del equipo.
- **Demo local:** React y FastAPI trabajan con el mismo contrato en loopback. La UI usa el origen de clasificación recibido, y el backend conserva SQLite, límite de solicitudes, autenticación opcional, CORS acotado y Slack apagado por defecto. Las 25 pruebas sin red de Kev, Groq, reglas, Slack y endpoints pasan; `pnpm build` también pasa. El producto está versionado desde la raíz; sigue pendiente desplegar la URL del frontend de producto. El dashboard `vigilia-project-pi.vercel.app` es el control interno del equipo, no el frontend del producto.

## Trazabilidad con el reto 4

El brief `hackIAthon-retos-filtro.pdf`, página 2, define el reto como un webhook de ingreso a emergencias que valida póliza y preexistencias y avisa a dos destinatarios. El alcance visible del frontend y la evidencia pendiente quedan separados así:

| Requisito del brief | Evidencia en el frontend | Estado que falta cerrar |
| --- | --- | --- |
| Activar el flujo ante un ingreso a emergencias | **Procesar ingreso** envía un evento sintético a `POST /webhook/ingreso` solo cuando alguien pulsa el botón. | Validar con el compañero cuál sistema dispara el webhook en la demo desplegada. La interfaz actual es una consola de demostración, no un receptor automático de eventos. |
| Revisar la validez de la póliza | El resultado muestra el veredicto, el estado de póliza y la explicación que devuelve el backend. | Confirmar que los escenarios sintéticos producen los resultados esperados contra el servicio publicado. |
| Revisar el historial de preexistencias | La pantalla distingue relaciones sugeridas y estados que requieren revisión humana. Jev y el backend se normalizan en un contrato interno de clasificación. | Validar localmente los seis casos. Con Kev o Groq, una sugerencia nunca elimina la necesidad de revisión humana; con el proveedor desactivado queda pendiente. |
| Avisar a admisiones y al gestor de casos | El resultado presenta mensaje, canal y estado de envío en dos tarjetas separadas. [`backend/app/notifier.py`](https://github.com/rgkue/vigilia-project/blob/main/backend/app/notifier.py) usa `asyncio.gather` para iniciar ambos envíos en paralelo y simula con `log` si no hay webhooks Slack configurados. | Verificar la entrega a ambos destinatarios en un entorno de prueba seguro. No probar con canales de producción. |
| Entregar un agente funcional y un repositorio público | El repositorio público y el frontend React están versionados desde la raíz. | Publicar la URL del frontend de producto y completar la verificación end-to-end contra el backend. |

El botón de la demo y los datos sintéticos permiten recorrer el flujo visual sin fingir que el disparador automático, el análisis del agente o la entrega de notificaciones ya están comprobados.

## Siguientes pasos

1. **Resolver acceso ZDR antes de activar Jev en el backend.** Confirmar la disponibilidad de ZDR en el equipo AI Gateway, volver a probar el adaptador Python con casos ficticios y validar el proveedor de ruta efectiva. No enviar ingresos reales mientras ZDR no funcione.
2. **Probar un proveedor real solo con autorización y datos sintéticos.** Kev o Groq se activa desde la configuración privada del backend; el equipo elige uno expresamente, configura su clave localmente y revisa las respuestas de los seis fixtures.
3. **Preparar una fase posterior de entrega.** Acordar el despliegue del frontend de producto y validar el flujo con la API publicada. No desplegar desde `vigilia-panel/` ni activar Firebase hasta completar esa revisión.

## Criterio de cierre

El hito local está listo: React y FastAPI funcionan juntos en loopback, los seis casos aparecen en el historial persistido, ambos avisos se simulan por `log` y las clasificaciones inciertas quedan para revisión humana. Jev continúa pendiente de una clave local; no bloquea la demo administrativa.

La llamada Jev del simulador está validada técnicamente con cuatro evaluaciones sintéticas estables, pero no acredita exactitud clínica ni habilita su uso con datos reales. El proveedor del backend requiere ZDR y su acceso sigue pendiente.
