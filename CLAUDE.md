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
| `sw.js` | Service worker — cachea el shell estático, cache actual `vf-v4` |
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
  `sw.js` → `const CACHE = 'vf-vX'`.
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
PDF/WhatsApp), 10 (Dashboard principal), 11 (Reportes + ganancia neta por vendedor).

**Pendiente — dos sub-proyectos secuenciales, diseño ya escrito y committeado, esperando
revisión final de Luis antes de pasar a plan de implementación:**
- 12 (Gestión de usuarios) — sin bloqueos, puede iniciar cuando se apruebe el spec en
  [docs/superpowers/specs/2026-07-30-gestion-usuarios-design.md](docs/superpowers/specs/2026-07-30-gestion-usuarios-design.md).
- 13 (Inventario multi-almacén) — **bloqueado por 12** (cada usuario nuevo necesita su
  almacén creado en la misma operación de alta). Spec en
  [docs/superpowers/specs/2026-07-30-multi-almacen-design.md](docs/superpowers/specs/2026-07-30-multi-almacen-design.md).

Los usuarios y roles fijos descritos abajo ("Usuarios y roles") dejarán de ser fijos una
vez que el ticket 12 esté implementado — se vuelven altas/bajas dinámicas desde la app.
