# Experimento Jev con AI SDK

## Alcance

La UI React llama a una ruta de servidor Vercel (`api/jev.ts`). Esa ruta usa `experimental_evaluate` del paquete `ai` para comparar el motivo de ingreso con los antecedentes de dos fixtures sintéticos existentes en el backend local. Jev devuelve una opción y su distribución; la UI la identifica como sugerencia. El agente Python no consume esta ruta todavía y el resultado no altera sus reglas ni los avisos.

La ruta fija las preguntas y los datos permitidos en el servidor, acepta solo `caseId` de los dos escenarios, rechaza solicitudes de otro origen y limita las llamadas locales por minuto. En la petición de navegador no viaja ningún otro campo del evento. No hay campos de texto libre.

## Configuración local

La raíz contiene un `.env.local` ignorado por Git. Introduce la clave directamente en ese archivo:

```dotenv
AI_GATEWAY_API_KEY=<escríbela aquí localmente>
```

No copies ese valor en el chat, en variables `VITE_*`, ni en código. Reinicia `pnpm dev` después de guardarla. El cliente AI SDK usa la variable solo en el proceso del servidor; la tarjeta indica si falta sin mostrarla. El endpoint funciona con Vite `dev` y con la función API de Vercel; `vite preview` solo sirve los archivos estáticos y no ejecuta la ruta.

En Vercel, agrega `AI_GATEWAY_API_KEY` como variable privada del entorno de servidor del proyecto cuando se publique la aplicación. No se debe cargar esa clave al frontend estático.

## Preguntas y respuesta segura

Para cada antecedente, Jev elige entre:

- `DIRECTA`: los textos describen la misma condición o una relación directa explícita.
- `POSIBLE`: podría existir relación, pero requiere revisión humana.
- `NINGUNA`: no se aprecia relación en los textos; esto no prueba que no exista clínicamente.

Se requiere una probabilidad de la opción elegida de al menos 0.75 para presentar la sugerencia; si falta la distribución o el resultado no la alcanza, queda como `PENDIENTE`. La evaluación usa un timeout de 12 segundos y no reintenta. El código Python conserva su implementación Kev independiente hasta revisar los resultados de Jev.

## Pendiente de validación

Cuando la clave esté cargada localmente, revisar ambos escenarios y comparar manualmente las sugerencias con las expectativas del reto. La cuota gratuita de Jev en Vercel AI Gateway se anuncia hasta el 25 de septiembre de 2026; confirmar en la consola el estado y el precio justo antes de llamar al modelo.

La API de evaluación del AI SDK es experimental. Una salida tipada y su probabilidad no validan exactitud. El flujo está limitado a datos ficticios, no permite entradas clínicas reales y nunca decide la validez de una póliza, cobertura o atención.

Fuentes oficiales: [modelo Jev en AI Gateway](https://vercel.com/ai-gateway/models/jev), [AI SDK evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation), [descripción de Jev y uso humano](https://vercel.com/i/what-is-jev).
