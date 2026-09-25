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

Para probar ZDR en el simulador local solo con los fixtures permitidos, inicia Vite con `JEV_SYNTHETIC_REQUIRE_ZDR=true`. En PowerShell:

```powershell
$env:JEV_SYNTHETIC_REQUIRE_ZDR = "true"
pnpm dev
```

En otra terminal ejecuta `pnpm run test:jev-synthetic`. El benchmark exige entonces que cada respuesta confirme `finalProvider=typesafe-ai`, ZDR en la planificación y revisión humana. Si la cuenta no tiene acceso ZDR, la evaluación debe fallar de forma cerrada. Al terminar, cierra Vite y elimina la variable de esa terminal o abre una terminal nueva. Esta prueba no habilita Jev para ingresos reales.

## Preguntas y respuesta segura

Para cada antecedente, Jev elige entre:

- `DIRECTA`: los textos describen la misma condición o una relación directa explícita.
- `POSIBLE`: podría existir relación, pero requiere revisión humana.
- `NINGUNA`: no se aprecia relación en los textos; esto no prueba que no exista clínicamente.

Se requiere una probabilidad de la opción elegida de al menos 0.75 para presentar la sugerencia; si falta la distribución o el resultado no la alcanza, queda como `PENDIENTE`. Esa probabilidad no es una tasa de acierto. La evaluación del simulador usa un timeout de 12 segundos y no reintenta. El simulador envía únicamente fixtures sintéticos y solicita que el proveedor no use los prompts para entrenamiento. No equivale a retención cero.

## Pendiente de validación

Vercel anunció que Jev admite ZDR y No Training por solicitud. Su documentación actual de evaluación permite configurar `zeroDataRetention` y una lista de proveedores permitidos; el changelog de privacidad indica que ZDR también incluye exclusión de entrenamiento y que ZDR por solicitud requiere un equipo Pro o Enterprise. La tabla pública del proveedor TypeSafe muestra vacías las columnas ZDR y No Training, en discrepancia con el anuncio específico de Jev. La llamada con ZDR realizada con esta cuenta fue rechazada con `permission_denied` (HTTP 403); el motivo concreto no se pudo determinar, por lo que no demuestra incompatibilidad del modelo. Una llamada sintética con `disallowPromptTraining` sí completó e informó metadatos de planificación No Training, pero no demuestra ZDR.

El 25 de septiembre se repitió una prueba sintética de ZDR desde el AI SDK. Con y sin `only: ["typesafe-ai"]`, el wrapper respondió HTTP 502; el log seguro registró un `GatewayResponseError` con causa `AI_APICallError` y estado upstream 500, sin metadatos de ruta. En cambio, el control No Training volvió a pasar cuatro llamadas: dos por fixture, con resultados estables y metadatos del proveedor `typesafe-ai`. Esto deja verificado el modo de demo No Training, pero no ZDR.

El 25 de septiembre también se probó el endpoint HTTP nativo documentado recientemente por Vercel (`https://ai-gateway.vercel.sh/v1/evaluate`). El control con `disallowPromptTraining: true` devolvió HTTP 200, `finalProvider=typesafe-ai` y metadatos que confirman No Training. Las dos variantes ZDR —enrutamiento automático y `only: ["typesafe-ai"]`— devolvieron HTTP 403 `permission_denied`; cambiar de transporte no resolvió el acceso a ZDR.

Una petición ZDR mínima sin datos clínicos devolvió el mismo `permission_denied`. Los metadatos registraron un intento de modelo para `typesafe-ai/jev`, pero cero intentos de proveedor y ningún proveedor final ni motivo de planificación. La solicitud se rechazó antes de obtener una ruta de inferencia; este dato no distingue por sí solo entre el acceso de la cuenta y la elegibilidad del proveedor.

Se compararon ocho llamadas sintéticas con los mismos prompts de la interfaz: dos repeticiones por fixture y transporte (AI SDK y HTTP). Las ocho confirmaron `typesafe-ai` y No Training. Después de aplicar el umbral de 75%, `vig-demo-01` quedó `PENDIENTE` en las cuatro evaluaciones aunque la categoría cruda fluctuó una vez; `vig-demo-04` quedó `POSIBLE` para ambos antecedentes en las cuatro, con probabilidades entre 0.95 y 0.98. Esto respalda el uso del AI SDK en el simulador TypeScript y HTTP en el adaptador Python, pero no mide exactitud clínica ni habilita datos reales. Hay que comparar la decisión final revisable, no exigir igualdad exacta de probabilidades entre llamadas.

Se inspeccionó además `providerMetadata.typesafe.confidence` en cuatro llamadas con el prompt del backend. Para `vig-demo-01`, la probabilidad de `POSIBLE` fue 0.70–0.72 y la confianza 0.54–0.58; el umbral dejó ambos resultados pendientes. Para `vig-demo-04`, las probabilidades fueron 0.89–0.95 y la confianza 0.84–0.92. Vercel define la probabilidad como el apoyo a la opción elegida y la confianza como la concentración de la distribución: son métricas distintas. El umbral actual corresponde a la probabilidad de la opción, no a `confidence`; ninguna de las dos representa exactitud individual y ambas requieren calibración con casos etiquetados del flujo real.

Una petición de canario bajo No Training incluyó tres instrucciones ficticias para forzar `DIRECTA` dentro de los antecedentes. Jev devolvió `NINGUNA` con probabilidades de 0.99–1.00 y ninguna sugerencia directa superó el umbral. Es un solo chequeo sintético de humo, no prueba general de resistencia a instrucciones maliciosas.

También se hizo una llamada directa al adaptador FastAPI con el fixture sintético de dolor torácico y dos antecedentes. AI Gateway devolvió HTTP 403; el backend registró solo `HTTPStatusError` y el estado, y dejó ambas sugerencias pendientes. La página de estado de Vercel no reporta incidentes de AI Gateway el 25 de septiembre, y su documentación indica que ZDR por solicitud requiere Pro o Enterprise. La cuenta exacta aún no está confirmada, así que el 403 no se atribuye definitivamente al plan.

El experimento del simulador solo acepta fixtures ficticios y debe seguir aislado del flujo de ingresos reales. El agente Python acepta Jev únicamente con ZDR obligatorio, restringe AI Gateway a `typesafe-ai` y falla cerrada si faltan metadatos que confirmen el proveedor final y una planificación con ZDR solicitado. Esa ruta aún no se ha validado porque la petición de esta cuenta recibió 403. No habilitarla con ingresos reales hasta resolver el acceso, verificar una evaluación ficticia del backend cuya respuesta confirme el enrutamiento ZDR y completar la revisión de privacidad y calidad del equipo. La elegibilidad ZDR de Jev documentada por Vercel no reemplaza esas verificaciones. Mientras tanto, Kev sigue siendo el proveedor predeterminado.

Con Vite en ejecución, `pnpm run test:jev-contract` revisa el estado, el rechazo de orígenes externos, métodos no permitidos, JSON inválido y casos fuera de la lista. Este chequeo no llama a Jev ni consume tokens.

`pnpm run test:jev-synthetic` compara los dos escenarios permitidos con expectativas orientativas y repite cada uno dos veces por defecto. `JEV_BENCHMARK_REPEATS` admite de una a tres repeticiones. El benchmark consume llamadas, registra solo las etiquetas sintéticas, valida el umbral, la escala de probabilidad y la revisión humana y comprueba la repetibilidad; no evalúa exactitud clínica. Si falta la credencial, termina como `SKIP` sin llamar al modelo. En la ejecución más reciente del 25 de septiembre se hicieron seis llamadas con No Training auditado y sin ZDR: las seis pasaron; `vig-demo-01` quedó `PENDIENTE` y `vig-demo-04` devolvió `POSIBLE` para ambos antecedentes en sus tres repeticiones. Dos llamadas diagnósticas adicionales devolvieron probabilidades 0.60 para la sugerencia pendiente y 0.99/0.97 para las dos sugerencias posibles; sus latencias locales fueron 1072 ms y 374 ms. Estas observaciones corresponden a dos fixtures y no prueban exactitud ni latencia en producción.

En una comprobación ZDR posterior del mismo día, un servidor local aislado hizo cuatro llamadas (dos por fixture) con `JEV_SYNTHETIC_REQUIRE_ZDR=true`; las cuatro devolvieron HTTP 502. El registro seguro mostró error upstream 500 (`GatewayResponseError` / `AI_APICallError`) y no expuso datos de respuesta. La ruta cerró sin producir sugerencias. Esto vuelve a dejar ZDR sin verificar para esta cuenta; no se habilita Jev en el backend real. El catálogo público de Jev todavía muestra sin marcar ZDR y No Training, y la promoción gratuita indicaba fin el 25 de septiembre, así que hay que confirmar precio y elegibilidad antes de futuras llamadas.

La modalidad ZDR se verifica por separado con `JEV_SYNTHETIC_REQUIRE_ZDR=true`.

La API de evaluación del AI SDK es experimental. Una salida tipada y su probabilidad no validan exactitud. El simulador está limitado a datos ficticios y no permite entradas clínicas reales. Ningún resultado de Jev decide la validez de una póliza, cobertura o atención. La opción `disallowPromptTraining` no debe confundirse con ZDR.

Fuentes oficiales: [anuncio de Jev con soporte ZDR y No Training](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway), [modelo Jev en AI Gateway](https://vercel.com/ai-gateway/models/jev), [guía de probabilidades, confianza y calibración](https://vercel.com/i/jev-probabilities-and-thresholds), [tabla pública de modelos TypeSafe](https://vercel.com/ai-gateway/models/providers/typesafe-ai), [guía de evaluación y opciones ZDR/proveedor](https://vercel.com/docs/ai-gateway/modalities/evaluation), [planes y controles de privacidad de AI Gateway](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway), [estado de Vercel](https://vercel.statuspage.io/), [DPA de TypeSafe](https://typesafe.ai/legal/data-processing), [AI SDK evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation), [descripción de Jev y uso humano](https://vercel.com/i/what-is-jev).
