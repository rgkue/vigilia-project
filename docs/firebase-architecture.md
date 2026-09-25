# Posible fase Firebase

Firebase puede complementar Vigilia, pero no conviene añadir todos sus servicios a la vez. La aplicación ya tiene un backend FastAPI/Python, reglas de póliza y almacenamiento SQLite en la adaptación local. Mantener dos bases activas para los mismos ingresos generaría dos fuentes de verdad.

## Orden recomendado

1. **Hosting del frontend.** Firebase Hosting puede servir la SPA estática de Vite desde `dist`. El archivo de salida se puede desplegar sin cambiar React. La función `api/jev.ts` actual, sin embargo, es una función de Vercel; al mover el hosting, esa ruta debe permanecer en Vercel con un proxy/CORS controlado o portarse a Cloud Functions/Cloud Run. Para la primera entrega, mantener el frontend y la función Jev juntos en Vercel evita separar el origen.
2. **Autenticación.** Si el equipo necesita cuentas, Firebase Authentication puede identificar al usuario en React. El frontend debe enviar el ID token a FastAPI, y el backend debe verificarlo y aplicar roles antes de devolver ingresos. Ocultar controles en React no protege el API.
3. **Persistencia.** Primero decidir una única fuente de verdad. Para producción, elegir entre una base gestionada que mantenga el modelo SQL existente o migrar el backend a Firestore; no escribir cada evento en SQLite y Firestore en paralelo. Firestore para acceso web requiere Firebase Auth, reglas de seguridad por rol/usuario, validación de datos y, según el riesgo, App Check.

## Datos y permisos

El reto trata pólizas y antecedentes médicos. No migrar datos reales a Firestore ni a otra plataforma externa hasta acordar finalidad, mínimo de datos, acceso por rol, región, retención, auditoría y aprobación de privacidad del equipo. La demo actual usa exclusivamente datos ficticios.

No se ha seleccionado ni vinculado un proyecto Firebase, no hay recursos cloud creados y no se han añadido credenciales Firebase al repositorio.

Fuentes oficiales: [Firebase Hosting](https://firebase.google.com/docs/hosting/quickstart), [autenticación web](https://firebase.google.com/docs/auth/web/start), [seguridad de Firestore](https://firebase.google.com/docs/firestore/security/overview) y [condiciones de Security Rules](https://firebase.google.com/docs/firestore/security/rules-conditions).
