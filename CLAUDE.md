# CLAUDE.md — PWA "Ventas Familia" (Lima's Sales)

Este archivo aplica **solo a este proyecto** (negocio familiar de reventa), separado del
CLAUDE.md global de Luis Manuel Lima Díaz (que cubre Gestión de Mantenimiento — Titan
Empaques). No mezclar contexto de ambos proyectos.

## Qué es

PWA de gestión de ventas para un negocio familiar de reventa al menudeo/menudeo-mayoreo.
4 usuarios fijos (Papá, Angie, Alexa, Alexis), sin categoría de producto fija — se revende
lo que se vaya consiguiendo. Marca visible: **"Lima's Sales"** (monograma "LS", degradado
teal/cyan sobre navy).

Documentos fuente de verdad — **leer antes de tocar código**:
- [SPEC.md](SPEC.md) — reglas de negocio completas (clientes, inventario, ventas, abonos,
  anulaciones, folios, recibos, dashboard, reportes, casos límite, fuera de alcance).
- [TICKETS.md](TICKETS.md) — desglose en tickets de corte vertical, con checklist y
  "Estado" de qué se probó en cada uno ya completado.
- `docs/superpowers/specs/` — design docs puntuales (ej. anulaciones, recibos PDF/WhatsApp).

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
| `styles.css` | Estilos — paleta teal/navy "Lima's Sales" |
| `sw.js` | Service worker — cachea el shell estático, cache actual `vf-v7` |
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
para el diseño completo).

**Pendiente:** ninguno de los tickets 01-15. Próximos pasos por definir con Luis.

Los usuarios y roles fijos descritos abajo ("Usuarios y roles") dejaron de ser fijos con
el ticket 12 — ahora son altas/bajas dinámicas desde la app (sección "Mi cuenta"). El
stock descrito en "Archivos del proyecto"/`app.js` ya no es un total único por producto —
está distribuido en almacenes (ticket 13); ver la pantalla "Movimientos" para el
historial completo.
