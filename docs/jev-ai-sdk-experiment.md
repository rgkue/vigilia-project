# Experimento Jev con AI SDK

## Alcance

La UI React llama a una ruta de servidor Vercel (`api/jev.ts`). Esa ruta usa `experimental_evaluate` del paquete `ai` para comparar el motivo de ingreso con los antecedentes de dos fixtures sintéticos existentes en el backend local. Jev devuelve una opción y su distribución; la UI la identifica como sugerencia. El agente Python no consume esta ruta todavía y el resultado no altera sus reglas ni los avisos.

La ruta fija las preguntas y los datos permitidos en el servidor, acepta solo `caseId` de los dos escenarios y rechaza solicitudes de otro origen. Valida el identificador antes de comprobar credenciales o llamar al modelo; un caso desconocido no consume llamadas. El límite de ocho llamadas por minuto es en memoria por proceso y sirve como protección básica del experimento, no como límite distribuido para producción. En la petición de navegador no viaja ningún otro campo del evento. No hay campos de texto libre.

## Configuración local

La raíz contiene un `.env.local` ignorado por Git. Introduce la clave directamente en ese archivo:

```dotenv
AI_GATEWAY_API_KEY=<escríbela aquí localmente>
```

No copies ese valor en el chat, en variables `VITE_*`, ni en código. Reinicia `pnpm dev` después de guardarla. El cliente AI SDK usa la variable solo en el proceso del servidor; la tarjeta indica si falta sin mostrarla. El endpoint funciona con Vite `dev` y con la función API de Vercel; `vite preview` solo sirve los archivos estáticos y no ejecuta la ruta.

En Vercel, configura una variable privada `AI_GATEWAY_API_KEY` o habilita la autenticación OIDC para AI Gateway en el proyecto. El estado de Jev reconoce cualquiera de las dos credenciales; no se debe cargar una clave al frontend estático.

## Preguntas y respuesta segura

Para cada antecedente, Jev elige entre:

- `DIRECTA`: los textos describen la misma condición o una relación directa explícita.
- `POSIBLE`: podría existir relación, pero requiere revisión humana.
- `NINGUNA`: no se aprecia relación en los textos; esto no prueba que no exista clínicamente.

Se requiere una probabilidad de la opción elegida de al menos 0.75 para presentar la sugerencia; si falta la distribución o el resultado no la alcanza, queda como `PENDIENTE`. Esa probabilidad no es una tasa de acierto. La evaluación usa un timeout de 12 segundos y no reintenta. AI Gateway recibe filtros para excluir proveedores sin política de no entrenamiento y de retención cero; si no existe una ruta compatible, la evaluación falla cerrada. El modelo Jev no se usa en el ingreso real de FastAPI.

## Pendiente de validación

Cuando una credencial nueva esté configurada localmente, revisar ambos escenarios y comparar manualmente las sugerencias con expectativas escritas antes de la llamada. Confirmar en AI Gateway el precio y las garantías actuales del proveedor antes de cualquier prueba.

La ficha actual del proveedor Jev no muestra garantías de ZDR ni de no entrenamiento. Por ello, esta ruta acepta únicamente fixtures ficticios y debe seguir aislada del flujo con datos de personas. No promover el proveedor a FastAPI hasta demostrar calidad en un conjunto de evaluación suficiente y confirmar las condiciones de tratamiento de datos para el uso previsto.

Con Vite en ejecución, `pnpm run test:jev-contract` revisa el estado, el rechazo de orígenes externos, métodos no permitidos, JSON inválido y casos fuera de la lista. Este chequeo no llama a Jev ni consume tokens.

Con una credencial rotada y configurada, `pnpm run test:jev-synthetic` compara los dos escenarios permitidos con expectativas orientativas y repite cada uno dos veces por defecto. `JEV_BENCHMARK_REPEATS` admite de una a tres repeticiones. El benchmark consume llamadas, registra solo las etiquetas sintéticas y su repetibilidad y no evalúa exactitud clínica. Si falta la credencial, termina como `SKIP` sin llamar al modelo.

La API de evaluación del AI SDK es experimental. Una salida tipada y su probabilidad no validan exactitud. El flujo está limitado a datos ficticios, no permite entradas clínicas reales y nunca decide la validez de una póliza, cobertura o atención.

Fuentes oficiales: [modelo Jev en AI Gateway](https://vercel.com/ai-gateway/models/jev), [AI SDK evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation), [descripción de Jev y uso humano](https://vercel.com/i/what-is-jev).
