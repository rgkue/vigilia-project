# Experimento Jev con AI SDK

## Alcance

La UI React llama a una ruta de servidor Vercel (`api/jev.ts`). Esa ruta usa `experimental_evaluate` del paquete `ai` para comparar el motivo de ingreso con los antecedentes de dos fixtures sintéticos existentes en el backend local. Jev devuelve una opción y su distribución; la UI la identifica como sugerencia. Esta prueba no cambia las reglas ni los avisos.

El agente Python también tiene un adaptador opcional para Jev mediante el endpoint de evaluación de AI Gateway. Solo se activa al elegir explícitamente `VIGILIA_AI_PROVIDER=jev`; Kev permanece como opción predeterminada. Para el flujo del backend, que puede recibir datos de ingresos reales, el adaptador exige ZDR en cada solicitud y falla cerrada si el Gateway lo rechaza. No hay failover automático. Solo envía el motivo de ingreso y los nombres de antecedentes; excluye identificadores, hospital, póliza y demás campos del evento.

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

Se requiere una probabilidad de la opción elegida de al menos 0.75 para presentar la sugerencia; si falta la distribución o el resultado no la alcanza, queda como `PENDIENTE`. Esa probabilidad no es una tasa de acierto. La evaluación del simulador usa un timeout de 12 segundos y no reintenta. El simulador envía únicamente fixtures sintéticos y solicita que el proveedor no use los prompts para entrenamiento. No equivale a retención cero.

## Pendiente de validación

Vercel anunció que Jev admite ZDR y No Training por solicitud. Su documentación actual de evaluación permite configurar `zeroDataRetention` y una lista de proveedores permitidos; el changelog de privacidad indica que ZDR también incluye exclusión de entrenamiento y que ZDR por solicitud requiere un equipo Pro o Enterprise. La tabla pública del proveedor TypeSafe muestra vacías las columnas ZDR y No Training, en discrepancia con el anuncio específico de Jev. La llamada con ZDR realizada con esta cuenta fue rechazada con `permission_denied` (HTTP 403); el motivo concreto no se pudo determinar, por lo que no demuestra incompatibilidad del modelo. Una llamada sintética con `disallowPromptTraining` sí completó e informó metadatos de planificación No Training, pero no demuestra ZDR.

El experimento del simulador solo acepta fixtures ficticios y debe seguir aislado del flujo de ingresos reales. El agente Python acepta Jev únicamente con ZDR obligatorio, restringe AI Gateway a `typesafe-ai` y falla cerrada si faltan metadatos que confirmen el proveedor final y una planificación con ZDR solicitado. Esa ruta aún no se ha validado porque la petición de esta cuenta recibió 403. No habilitarla con ingresos reales hasta resolver el acceso, verificar una evaluación ficticia del backend cuya respuesta confirme el enrutamiento ZDR y completar la revisión de privacidad y calidad del equipo. La elegibilidad ZDR de Jev documentada por Vercel no reemplaza esas verificaciones. Mientras tanto, Kev sigue siendo el proveedor predeterminado.

Con Vite en ejecución, `pnpm run test:jev-contract` revisa el estado, el rechazo de orígenes externos, métodos no permitidos, JSON inválido y casos fuera de la lista. Este chequeo no llama a Jev ni consume tokens.

`pnpm run test:jev-synthetic` compara los dos escenarios permitidos con expectativas orientativas y repite cada uno dos veces por defecto. `JEV_BENCHMARK_REPEATS` admite de una a tres repeticiones. El benchmark consume llamadas, registra solo las etiquetas sintéticas, valida el umbral, la escala de probabilidad y la revisión humana y comprueba la repetibilidad; no evalúa exactitud clínica. Si falta la credencial, termina como `SKIP` sin llamar al modelo. En la última ejecución se hicieron tres repeticiones por escenario (seis llamadas): todas pasaron y fueron estables. `vig-demo-01` quedó `PENDIENTE`; `vig-demo-04` devolvió `POSIBLE` para ambos antecedentes.

La API de evaluación del AI SDK es experimental. Una salida tipada y su probabilidad no validan exactitud. El simulador está limitado a datos ficticios y no permite entradas clínicas reales. Ningún resultado de Jev decide la validez de una póliza, cobertura o atención. La opción `disallowPromptTraining` no debe confundirse con ZDR.

Fuentes oficiales: [anuncio de Jev con soporte ZDR y No Training](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway), [modelo Jev en AI Gateway](https://vercel.com/ai-gateway/models/jev), [tabla pública de modelos TypeSafe](https://vercel.com/ai-gateway/models/providers/typesafe-ai), [guía de evaluación y opciones ZDR/proveedor](https://vercel.com/docs/ai-gateway/modalities/evaluation), [planes y controles de privacidad de AI Gateway](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway), [DPA de TypeSafe](https://typesafe.ai/legal/data-processing), [AI SDK evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation), [descripción de Jev y uso humano](https://vercel.com/i/what-is-jev).
