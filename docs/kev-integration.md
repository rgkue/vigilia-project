# Proveedores de clasificación: Kev y Groq

## Decisión de arquitectura

El backend local conserva el contrato y la separación de responsabilidades de origin/main, pero usa Kev como proveedor predeterminado. La integración Groq publicada en [f6c4164](https://github.com/rgkue/vigilia-project/commit/f6c4164a0f2369c1d21460850db1f5108940c853) se incorporó como una alternativa seleccionable, sin reemplazar la ruta local de Kev.

Configura VIGILIA_AI_PROVIDER=kev o VIGILIA_AI_PROVIDER=groq; no hay failover automático de un proveedor a otro. Así el backend nunca envía texto de salud a un segundo servicio sin una decisión explícita. none desactiva la clasificación automática. Kev es el predeterminado; Groq usa el endpoint oficial y el modelo indicado en GROQ_MODEL. El commit remoto fijaba llama-3.3-70b-versatile, que Groq retiró para planes Developer el 16 de agosto de 2026; la configuración local usa openai/gpt-oss-120b, alternativa recomendada y compatible con modo JSON. Consulta [la política de deprecación](https://console.groq.com/docs/deprecations) y [el detalle del modelo](https://console.groq.com/docs/model/openai/gpt-oss-120b) antes de activar el proveedor.

Ambos proveedores solo proponen DIRECTA, POSIBLE o NINGUNA. La respuesta de FastAPI conserva el enum público definido en backend/app/schemas.py. Si la clasificación falta, falla o es inválida, la API devuelve NINGUNA en ese campo junto con el prefijo Revisión humana pendiente:; la interfaz lo normaliza a PENDIENTE y no lo presenta como una conclusión. Toda sugerencia válida de IA también requiere revisión humana.

Las reglas deterministas del commit remoto están disponibles como pistas opcionales con VIGILIA_RULES_FALLBACK=true. Una coincidencia de respaldo queda igualmente pendiente y nunca se usa como confirmación. Por defecto el respaldo está apagado. Una clasificación de IA o regla que siga pendiente produce una alerta MEDIO; no puede elevar por sí sola una póliza vigente a ALTO. Las reglas exactas de vigencia, pago y carencia siguen siendo código normal en rules.py.

Los avisos se generan con plantillas locales; el modelo no escribe mensajes libres, consulta SQLite ni decide atención o cobertura. Las notificaciones Slack siguen desactivadas hasta configurar explícitamente SLACK_ENABLED=true y sus webhooks.

## Privacidad y seguridad

Las solicitudes de Kev y Groq solo incluyen el motivo del ingreso y las condiciones previas que se comparan. Omiten cédula, nombre, hospital, identificador del evento y triage. Aun así, ambos textos pueden ser datos de salud. Para la demo usa exclusivamente los fixtures sintéticos; no envíes información de pacientes a un proveedor externo sin autorización y revisión de privacidad del equipo.

GROQ_API_KEY y KEV_API_KEY pertenecen únicamente al entorno privado del backend y nunca deben tener prefijo VITE_. La llamada a Groq usa una URL fija HTTPS y desactiva redirecciones; los errores registrados no incluyen el cuerpo de la solicitud ni las claves.

Kev requiere KEV_API_URL. El adaptador acepta HTTPS remoto (con clave) y HTTP solo para localhost, 127.0.0.1 o ::1; no permite credenciales ni query strings en la URL.

## Configuración

| Variable | Uso | Valor predeterminado |
| --- | --- | --- |
| VIGILIA_AI_PROVIDER | Proveedor: kev, groq o none | kev |
| VIGILIA_RULES_FALLBACK | Incluir una pista de reglas cuando el proveedor no responde | false |
| KEV_API_URL | Host de Kev, o ruta /v1 / /v1/systemone | vacío (revisión pendiente) |
| KEV_API_KEY | Bearer key del servicio Kev remoto | vacío; obligatoria para host remoto |
| KEV_MODEL | Modelo servido por Kev | kev-latest |
| KEV_MIN_PROBABILITY | Umbral mínimo de Kev | 0.75 |
| KEV_TIMEOUT_SECONDS | Timeout de Kev | 8 segundos |
| GROQ_API_KEY | Clave del API de Groq | vacío |
| GROQ_MODEL | Modelo del API de Groq | openai/gpt-oss-120b |
| GROQ_TIMEOUT_SECONDS | Timeout de Groq | 8 segundos |

backend/.env.example contiene valores vacíos o seguros para comenzar. No copies secretos a src/, a variables VITE_* ni a .env.example.

## Verificación

Las pruebas de backend/tests/ simulan las respuestas de Kev y Groq sin hacer llamadas a Internet. Las 25 pruebas comprueban minimización de datos, validación de formato, errores, pistas de respaldo pendientes, escape de menciones Slack, contrato FastAPI, CORS, autenticación opcional, límite de solicitudes y que una sugerencia directa pendiente no se convierta en prioridad alta.

Desde backend/, ejecuta:

    pip install -r requirements-dev.txt
    python -m unittest discover -s tests -v
    python -m pytest -q

El backend declara httpx para ambos adaptadores. Kev, si se usa, se despliega por separado. Groq solo se activa seleccionándolo y configurando su clave en el entorno privado.