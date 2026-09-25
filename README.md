# Vigilia · Frontend

Interfaz React para la demo del reto 4 del hackIAthon: muestra un ingreso de emergencia, el resultado administrativo de la API y los avisos dirigidos a admisiones y al gestor de casos.

`vigilia-panel/` es el tablero interno del equipo. Esta aplicación de producto se ejecuta desde la raíz del repositorio.

## Desarrollo local

```bash
pnpm install
pnpm dev
```

Sin configuración adicional, la interfaz usa seis casos sintéticos alineados con las cédulas de prueba del backend y deja claro que los avisos son locales. Para conectar el servicio Python/FastAPI, copia `.env.example` a `.env.local` y configura `VITE_API_BASE_URL`. La interfaz comprueba `/health`, carga los últimos diez ingresos del backend y adapta las respuestas documentadas; la guía está en [docs/frontend-backend-contract.md](docs/frontend-backend-contract.md).

### Experimento Jev con AI Gateway

El proyecto incluye el paquete `ai` y una función privada `POST /api/jev` que usa `experimental_evaluate` con el modelo `typesafe-ai/jev`. En `.env.local`, escribe localmente el valor de `AI_GATEWAY_API_KEY` y reinicia `pnpm dev`; no lo pegues en el chat. `.env.local` está ignorado por Git. La función de Vercel lee el mismo nombre desde sus variables de entorno.

La tarjeta **Probar clasificación Jev** solo admite los casos sintéticos `vig-demo-01` y `vig-demo-04`. El navegador envía el identificador del escenario; el servidor selecciona los textos ficticios. No se envían cédula, nombre, hospital ni datos escritos por el usuario. Jev solo sugiere `DIRECTA`, `POSIBLE` o `NINGUNA`; salidas incompletas o bajo el umbral quedan pendientes. El resultado experimental no modifica el veredicto del backend ni decide póliza, cobertura o atención. La ruta local solo está disponible con `pnpm dev`, no con `pnpm preview`.

Vercel anuncia Jev gratis hasta el **25 de septiembre de 2026**; confirma el precio mostrado en AI Gateway antes de usarlo después de esa fecha. La evaluación oficial es experimental y sus probabilidades no demuestran precisión clínica. Detalles y límites en [docs/jev-ai-sdk-experiment.md](docs/jev-ai-sdk-experiment.md).

El plan está en [docs/plan.md](docs/plan.md). El backend local mantiene Kev como proveedor predeterminado y ahora integra Groq como alternativa explícita (`VIGILIA_AI_PROVIDER=groq`), junto con las reglas de respaldo remoto como pistas opcionales pendientes de revisión. Ambos usan el mismo contrato FastAPI; no hay failover automático ni una sugerencia decide cobertura o atención. Consulta [proveedores de clasificación](docs/kev-integration.md) y [el contrato frontend/API](docs/frontend-backend-contract.md).

## API local

Requiere Python 3.11 o superior. Desde la carpeta `backend/`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

La API queda en `http://127.0.0.1:8000`; su documentación interactiva está en `/docs`. CORS solo permite por defecto el frontend local `http://127.0.0.1:5173`; cambia `VIGILIA_CORS_ORIGINS` únicamente al configurar un origen conocido.

La demo usa SQLite y datos sintéticos. Kev queda pendiente si `KEV_API_URL` está vacío; Groq solo se activa con `VIGILIA_AI_PROVIDER=groq` y una clave en el entorno privado del backend. Las reglas de respaldo son opcionales (`VIGILIA_RULES_FALLBACK=false` por defecto) y sus resultados siguen pendientes de revisión humana. Slack permanece desactivado (`SLACK_ENABLED=false`). Para conectar React en local, configura `VITE_API_BASE_URL=http://127.0.0.1:8000` en `.env.local`; no pongas claves backend en variables `VITE_*`.

Con el entorno Python activo, ejecuta desde `backend/` las pruebas sin red de Kev, Groq, reglas y contrato API:

```powershell
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python -m pytest -q
```

## Publicar el frontend

Configura Vercel como un proyecto independiente con la raíz del repositorio como directorio del frontend de producto; no selecciones el tablero interno como raíz de Vercel.

Después, despliega el frontend de producto como un proyecto Vercel independiente conectado a ese repositorio. Configura la raíz del proyecto de Vercel en la raíz del repositorio, donde están `package.json` y `vite.config.ts`; no selecciones `vigilia-panel/`, que es el tablero interno de desarrollo.

- Framework: Vite.
- Comando de instalación: `pnpm install --frozen-lockfile`.
- Comando de compilación: `pnpm build`.
- Directorio de salida: `dist`.
- Variable `VITE_API_BASE_URL`: dejar vacía para una demo local o definirla solo cuando el equipo confirme el dominio público estable del backend.
- `VITE_INGRESO_PATH` es opcional; su valor predeterminado es `/webhook/ingreso`.

No agregues `VIGILIA_KEY`, claves de Anthropic ni webhooks de Slack como variables `VITE_*`: quedarían expuestas al navegador. Consulta [el contrato frontend/API](docs/frontend-backend-contract.md) antes de habilitar el envío de eventos al backend.

Firebase es una alternativa posible para alojar el frontend o añadir autenticación; revisa primero [la arquitectura propuesta](docs/firebase-architecture.md). No mezcles Firestore con SQLite como dos fuentes de verdad.

```bash
pnpm build
pnpm preview
```

## Principio del producto

Vigilia genera una alerta administrativa para coordinar una revisión. No hace triage clínico ni determina si una persona recibe atención; el paciente siempre es atendido.

La dirección de vidrio esmerilado usa CSS propio y toma como referencia [Liquid Glass de Apple](https://developer.apple.com/design/human-interface-guidelines/materials) y [OpenGlass UI](https://github.com/moekoelueker/open-glass-ui). Reserva el blur para navegación y superficies de control; los paneles de lectura mantienen fondo opaco para cuidar jerarquía y contraste. También respeta preferencias de menos transparencia, colores forzados y movimiento reducido.
