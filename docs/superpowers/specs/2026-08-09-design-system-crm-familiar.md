# Design doc — Sistema de diseño "CRM Familiar" (café/crema)

**Fecha:** 2026-08-09
**Estado:** aprobado como base visual permanente por Luis Manuel Lima Díaz — pendiente
decidir alcance de implementación (ver preguntas abiertas al final).

## Origen

Luis compartió un prompt maestro de UI/UX completo (paleta, tipografía, espaciado,
componentes, responsive, accesibilidad) junto con una imagen de referencia de un CRM
café/crema con sidebar en desktop/laptop y bottom-nav en móvil. Instrucción textual:
"A partir de este momento, toda la interfaz visual, componentes, layouts, pantallas
nuevas y refactorizaciones de este proyecto deberán seguir obligatoriamente este
sistema de diseño como base."

Esto **reemplaza** la paleta teal/navy documentada en `CLAUDE.md` → sección "Diseño UI"
(la que decía "NO MODIFICAR sin consultar a Luis") — reemplazo autorizado directamente
por Luis, no una desviación no consultada.

## 1. Paleta

| Token | Valor | Uso |
|---|---|---|
| `--color-primary` | `#5C3A21` | Café oscuro — sidebar, botón primario |
| `--color-primary-hover` | `#4A2F1C` | Hover botón primario |
| `--color-secondary` | `#7A5233` | Café medio |
| `--color-accent` | `#9A6A43` | Café cálido — ítem activo en sidebar |
| `--color-coffee-light` | `#C49A73` | Café claro |
| `--color-beige` | `#DCC3A5` | Beige medio — borde botón secundario |
| `--color-cream` | `#F3E7D3` | Crema |
| `--color-background` | `#FBF7F0` | Fondo principal |
| `--color-surface` | `#FFFDF9` | Superficie / cards |
| `--color-text-primary` | `#2E2118` | Texto principal |
| `--color-text-secondary` | `#6F6258` | Texto secundario |
| `--color-text-disabled` | `#A99B90` | Texto deshabilitado |
| `--color-text-on-dark` | `#FFF9F3` | Texto sobre fondo oscuro |
| `--color-border` | `#E6D8C8` | Borde principal |
| `--color-border-soft` | `#EFE5D8` | Borde suave |
| `--color-success` | `#718355` | Pagado / éxito |
| `--color-warning` | `#C79052` | Pendiente / advertencia |
| `--color-danger` | `#B85745` | Vencido / error (rojo terracota, nunca rojo puro) |
| `--color-info` | `#8B735B` | Información neutral |

Evitar azul/cyan/morado salvo necesidad técnica puntual. Estados nunca dependen solo del
color — siempre texto + ícono + color.

## 2. Tipografía

`Inter`, fallback `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

| Elemento | Tamaño / peso |
|---|---|
| Título principal | 28px / 700 |
| Título de sección | 20px / 600 |
| Subtítulo | 16px / 600 |
| Texto normal | 14–16px / 400 |
| Texto secundario | 13–14px / 400 |
| Labels | 13–14px / 500 |
| KPI principal | 26–32px / 700 |

Nota: el `CLAUDE.md` actual del proyecto especifica Arial como tipografía — este cambio
la sustituye por Inter.

## 3. Espaciado

Escala fija: `4px · 8px · 12px · 16px · 24px · 32px · 48px`. Evitar valores arbitrarios.

## 4. Bordes, cards, radios

```css
--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 16px;
```

Card estándar:
```css
background: #FFFDF9;
border: 1px solid #E6D8C8;
border-radius: 12px;
box-shadow: 0 1px 3px rgba(92, 58, 33, 0.06);
```

## 5. Botones

- **Primario:** fondo `#5C3A21`, texto `#FFF9F3`, hover `#4A2F1C`, radius `8px`.
- **Secundario:** fondo `#FFFDF9`, borde `#DCC3A5`, texto `#5C3A21`.
- **Peligro:** `#B85745` (nunca rojo puro).

## 6. Navegación

- **Desktop/laptop (sidebar):** fondo `#5C3A21`, texto inactivo `#E8DACA`, texto activo
  `#FFF9F3`, ítem seleccionado con fondo `#9A6A43`. Colapsable en laptop si el ancho lo
  exige. Secciones: Dashboard, Ventas, Clientes, Productos, Inventario, Cobranza,
  Gastos, Reportes, Configuración.
- **Móvil (bottom-nav fijo):** Inicio, Ventas, **Nueva venta** (acción destacada),
  Clientes, Más. Sin sidebar en móvil.

## 7. Breakpoints y comportamiento responsive

| Rango | Referencia | Comportamiento |
|---|---|---|
| Desktop | 1920px+ | Sidebar completo, contenido con `max-width`, 4 KPIs por fila, tablas completas, paneles simultáneos |
| Laptop | 1366–1919px | Sidebar (compacto si hace falta), gaps/paddings reducidos, 4 KPIs si hay espacio, 2 columnas en secciones secundarias, sin scroll horizontal |
| Móvil | 320–767px | Sin sidebar, bottom-nav fijo, KPIs 2 por fila (1 en pantallas muy angostas), secciones apiladas, tablas → cards/filas enriquecidas (nunca scroll horizontal como solución principal) |

Formularios: 2 columnas en desktop cuando sea lógico; 1 columna en móvil, controles
táctiles ≥ 44×44px.

## 8. Componentes base a mantener/crear

Button, Input, Select, Card, Badge, Modal, Drawer, Table, ResponsiveList, KPI Card,
EmptyState, LoadingState, ErrorState, PageHeader, Sidebar, MobileNavigation. Una sola
librería de íconos (Lucide o Heroicons) en todo el proyecto — no mezclar estilos.

## 9. Prioridad ante dudas de diseño

Usabilidad > claridad > velocidad para completar tareas > responsive > accesibilidad >
consistencia > estética. Nunca sacrificar usabilidad por decoración.

## Decisiones confirmadas (2026-08-09)

1. **Alcance de escritorio: se construye ya.** Además de recolorear el PWA móvil actual,
   esta misma fase incluye diseñar y construir el layout desktop/laptop con sidebar
   (capacidad nueva — hoy la app es solo mobile).
2. **Nombre y marca: se mantiene "Lima's Sales"** (monograma LS existente) con la nueva
   paleta café/crema — no se adopta el nombre genérico "CRM Familiar" de la imagen de
   referencia, esa imagen solo aporta estructura/estilo, no branding.

Este documento es la fuente de verdad de los tokens. Aún no se ha tocado ningún archivo
de código real (`app.js`, `styles.css`, `index.html`) — sigue el paso de simulación
visual antes de implementar, según la forma de trabajo acordada en `CLAUDE.md`.
