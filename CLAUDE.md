# CLAUDE.md — PWA "Ventas Familia" (Lima's Sales)

Este archivo aplica **solo a este proyecto** (negocio familiar de reventa), separado del
CLAUDE.md global de Luis Manuel Lima Díaz (que cubre Gestión de Mantenimiento — Titan
Empaques). No mezclar contexto de ambos proyectos.

## Qué es

PWA de gestión de ventas para un negocio familiar de reventa al menudeo/menudeo-mayoreo.
4 usuarios fijos (Papá, Angie, Alexa, Alexis), sin categoría de producto fija — se revende
lo que se vaya consiguiendo. Marca visible: **"Lima's Sales"** (monograma "LS").

**Identidad visual (desde 2026-08-09):** paleta café/crema, ver
[docs/superpowers/specs/2026-08-09-design-system-crm-familiar.md](docs/superpowers/specs/2026-08-09-design-system-crm-familiar.md)
— reemplaza la paleta teal/navy original documentada en tickets anteriores. Base
obligatoria para toda pantalla nueva o refactor visual. Incluye layout de escritorio
(sidebar) además del mobile-first actual — pendiente de implementar, aún en fase de
simulación (ver módulo CRM en curso).

Documentos fuente de verdad — **leer antes de tocar código**:
- [SPEC.md](SPEC.md) — reglas de negocio completas (clientes, inventario, ventas, abonos,
  anulaciones, folios, recibos, dashboard, reportes, casos límite, fuera de alcance).
- [TICKETS.md](TICKETS.md) — desglose en tickets de corte vertical, con checklist y
  "Estado" de qué se probó en cada uno ya completado.
- `docs/superpowers/specs/` — design docs puntuales (ej. anulaciones, recibos PDF/WhatsApp,
  sistema de diseño café/crema).

## URLs y repositorio

- **GitHub repo:** `https://github.com/ciegus/Ventas-Familia`
- **App en vivo (Vercel):** `https://ventas-familia.vercel.app`
- **Vercel:** proyecto `ventas-familia` en team `Ciegus` (plan Hobby) — deploy automático
  al hacer push a `main` (sin build step, sirve los archivos estáticos tal cual).
- **Directorio local:** `C:\Users\DELL\Documents\IA-Claude- Proyecto MPM\PWA - Aplicaciones\Ventas Familia`
- **Supabase:** proyecto `ventas-familia` (ref `wiewxgkiefsjeonirsid`, región us-east-1,
  org Ciegus). RLS deshabilitado a propósito en la mayoría de tablas (fuera de alcance v1,
  SPEC sección 13) — sí hay políticas RLS abiertas en `storage.objects` del bucket
  `productos` (necesarias aunque el bucket sea "público", ver TICKETS ticket 01).

## Archivos del proyecto

| Archivo | Propósito |
|---------|-----------|
| `index.html` | Login + shell principal (4 pestañas) + overlays (bottom sheets, paneles fullscreen) |
| `app.js` | Toda la lógica JS — módulo ES, importa `@supabase/supabase-js`, `html2canvas`, `jsPDF` desde `esm.sh` (sin build step) |
| `styles.css` | Estilos — paleta café/crema "Lima's Sales" (ver design doc 2026-08-09) |
| `sw.js` | Service worker — cachea el shell estático, versión leída de `version.js` |
| `version.js` | Fuente única del número de versión, leída por `sw.js` y `app.js` |
| `manifest.json` | PWA manifest |
| `icon.svg` | Ícono/logo "LS" |

## Usuarios y roles

| Nombre | Rol | Nota |
|--------|-----|------|
| Papá | admin | Puede anular CUALQUIER venta/abono, no solo lo suyo |
| Angie | vendedor | Vende, abona, anula solo lo suyo |
| Alexa | vendedor | Igual que Angie |
| Alexis | vendedor | Igual que Angie |

Filosofía "todos ven todo" — no hay pantallas ni reportes ocultos entre roles; la única
diferencia real es la capacidad de anular registros ajenos. Contraseña temporal sembrada:
`2026` (pendiente que cada quien la cambie).

## Forma de trabajo (instrucción de Luis, 2026-08-09)

Luis expone el **problema** que quiere resolver; Claude actúa como el profesional y
desarrolla la **solución completa** — no limitarse a lo literal pedido, sino sugerir lo
que el sistema debe tener. Para toda funcionalidad nueva, el orden obligatorio es:

1. **Auditar** el código y esquema reales (nunca suponer la arquitectura).
2. **Investigar** cómo lo resuelven sistemas reales del ramo (búsqueda web con fuentes).
3. **Simular** — mockup HTML navegable con la paleta real de la app, datos ficticios y
   variantes estructurales para elegir, ANTES de escribir plan o código.
4. **Decidir** — la simulación cierra con las decisiones concretas que Luis debe tomar.
5. Solo después: congelar diseño → actualizar SPEC.md → tickets chicos verificables.

## Convenciones de este proyecto

- **Sin build step** — HTML/CSS/JS planos, librerías vía `esm.sh` en imports ESM. No usar
  bundlers ni transpiladores salvo que se decida explícitamente lo contrario.
- **Offline no es prioridad** (SPEC sección 9) — cualquier escritura (venta, abono, alta de
  cliente/producto) exige conexión activa en el momento; si no hay internet, error claro
  vía `assertOnline()` — nunca falla en silencio ni encola.
- **Nunca se borra un registro físicamente** — ventas y abonos se marcan `anulado` +
  `anulado_por` + `anulado_en`.
- **Regla de caché:** cada vez que se modifica `app.js` o `styles.css`, subir el número en
  `version.js` → `self.CACHE_VERSION = 'vf-vX'` (fuente única, leída por `sw.js` vía
  `importScripts` y por `app.js`).
- **Folios:** formato `REC-XXXXXXXX`, generados por la función SQL `generate_folio()` —
  nunca generados en el cliente.
- **Money/fecha:** usar los formateadores ya definidos en `app.js` (`money` con
  `Intl.NumberFormat('es-MX', ...)`, `fechaFmt` con `Intl.DateTimeFormat('es-MX', ...)`) en
  vez de crear nuevos.

## Comando para subir cambios

```powershell
cd "C:\Users\DELL\Documents\IA-Claude- Proyecto MPM\PWA - Aplicaciones\Ventas Familia"
git add -A
git commit -m "descripcion del cambio"
git push
```

Cada push a `main` en GitHub dispara un redeploy automático en Vercel — no hace falta
ningún paso manual adicional.

## Progreso (ver TICKETS.md para detalle completo)

Completados: 01 (esquema Supabase), 02 (shell + login), 03 (Clientes), 04 (Inventario),
05 (venta de contado), 06 (venta a crédito), 07 (Abonos), 08 (Anulaciones), 09 (recibos
PDF/WhatsApp), 10 (Dashboard principal), 11 (Reportes + ganancia neta por vendedor),
12 (Gestión de usuarios), 13 (Inventario multi-almacén — stock distribuido por almacén,
pantalla "Movimientos", ver [docs/superpowers/specs/2026-07-30-multi-almacen-design.md](docs/superpowers/specs/2026-07-30-multi-almacen-design.md)
para el diseño completo), 14 (Deuda de consigna por vendedor — cuenta interna
Papá↔vendedor separada del crédito a Clientes, dentro de la pantalla "Movimientos", ver
[docs/superpowers/specs/2026-07-31-consigna-vendedores-design.md](docs/superpowers/specs/2026-07-31-consigna-vendedores-design.md)
para el diseño completo), 15 (Login en 2 pasos categoría→nombre→contraseña + versión
visible con botón de actualización, ver
[docs/superpowers/specs/2026-08-01-login-2pasos-version-design.md](docs/superpowers/specs/2026-08-01-login-2pasos-version-design.md)
para el diseño completo), 16 (Reportes: lista de vendedores dinámica en vez de la
constante hardcodeada `VENDEDORES_FIJOS`, que ya no coincidía con los usuarios reales —
hallazgo de `PROJECT_AUDIT.md`).

**En progreso:** ticket 17 — migrar el login de la función propia `login_usuario()` a
Supabase Auth real (JWT por usuario) y habilitar RLS en las 11 tablas, para cerrar el
hallazgo crítico de `PROJECT_AUDIT.md` sección 8. Diseño completo en
[docs/superpowers/specs/2026-08-03-auth-real-rls-design.md](docs/superpowers/specs/2026-08-03-auth-real-rls-design.md),
ejecutado por fases (cada una verificable antes de la siguiente, sin ambiente de staging
— deuda técnica #6 del audit). **Fase A y Fase B completadas y cerradas** (2026-08-04): los 5
usuarios reales tienen cuenta en Supabase Auth (correo interno
`@ventasfamilia.internal`, nunca visible en la UI) enlazada a su fila de `usuarios` vía
`auth_id`; el login del frontend ya usa `supabase.auth.signInWithPassword()` en vez de la
función vieja — verificado en vivo contra producción (`ventas-familia.vercel.app`, no
solo local): login/dashboard/Reportes/logout sin errores de consola, y los 5 usuarios
reales (Luis, Angie, Alexa, Alexis, Regina) confirmaron que su contraseña temporal les
funciona. **Fase C completada (2026-08-04): RLS habilitado en las 11 tablas, las 14 funciones de
escritura ya resuelven "quién soy" desde `auth.uid()` en vez de un parámetro que mandaba
el cliente sin verificar.** El hallazgo crítico del audit (RLS apagado + clave anon
pública = lectura/escritura completa sin pasar por las funciones) está cerrado —
verificado en vivo con un cliente `anon` aislado (0 filas, funciones de escritura
rechazadas a nivel de permiso). Durante la verificación se encontraron y corrigieron 4
bugs reales (mismo origen: columnas `id`/`folio`/`rol` ambiguas contra las variables de
salida de `RETURNS TABLE` en `anular_venta`, `anular_abono`, `crear_producto`,
`crear_usuario`) — detalle completo en el design doc. **Pendiente que Luis confirme al
menos una acción admin real (entrada de producto o traspaso) — solo se pudo probar el
camino de rechazo (`PERMISO_DENEGADO`) para las funciones admin-only, no el de éxito, por
no contar con una contraseña de admin real durante la sesión.**

**Pendiente: Fase D** (Edge Function `admin-usuarios` con `service_role`, para que el
admin pueda seguir dando de alta usuarios y reseteando contraseñas ajenas desde la app —
Supabase Auth no permite eso desde una función SQL). **Mientras tanto, "Nuevo usuario" y
"resetear contraseña de otro" quedaron bloqueados en la UI con un mensaje claro** (en vez
de dejarlos parecer que funcionan sin tener ningún efecto real) — editar nombre/rol/
activo de un usuario existente sí funciona. El cambio de contraseña propia ("Mi cuenta")
ya no depende de esto — se migró a `supabase.auth.updateUser()` y se probó de punta a
punta.

**Pendiente:** ver ticket 17 (Fase D) arriba. Además de los tickets 01-16, también están
cerrados 18 (ver/reenviar recibo desde Historial), 19 (buscador de cliente en Nueva
venta/Nuevo abono), 20 (desglose de stock por almacén en Inventario), 21 (identidad
visual café/crema — recoloreo, confirmado por Luis en producción 2026-08-09) y 22
(layout de escritorio con sidebar, confirmado por Luis en producción 2026-08-09). Ver
[docs/superpowers/specs/2026-08-09-design-system-crm-familiar.md](docs/superpowers/specs/2026-08-09-design-system-crm-familiar.md)
para el diseño completo de ambos.

**En progreso: ticket 23 — módulo CRM** (ficha de cliente, seguimientos, registro de
contacto, sugerencia de interés al dar de alta producto). Reglas de negocio y
evaluación de flujo en `SPEC.md` sección 17. Esquema de Supabase (tabla
`interacciones` + RLS + trigger de auditoría) e interfaz completa ya construidos y
subidos a producción (2026-08-09, commit `4e0e740`) — **pendiente que Luis confirme el
camino de éxito con su sesión real**: registrar un contacto, cerrarlo (Compró/No
quiso) y posponerlo. Hasta esa confirmación, el ticket sigue abierto. Detalle completo,
incluyendo los recortes de alcance deliberados de esta primera versión (sin selector de
venta al cerrar "Compró", confirm/prompt nativos en vez de sheets a medida, sin alta
rápida de contacto para no-clientes), en `TICKETS.md` ticket 23.

Los usuarios y roles fijos descritos abajo ("Usuarios y roles") dejaron de ser fijos con
el ticket 12 — ahora son altas/bajas dinámicas desde la app (sección "Mi cuenta"). El
stock descrito en "Archivos del proyecto"/`app.js` ya no es un total único por producto —
está distribuido en almacenes (ticket 13); ver la pantalla "Movimientos" para el
historial completo.
