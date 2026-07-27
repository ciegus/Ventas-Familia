# Ticket 09 — Recibos: PDF y WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar "Descargar PDF" y "Compartir WhatsApp" a los recibos de venta y abono que los tickets 05/07 ya construyen en pantalla.

**Architecture:** Un helper compartido (`capturarRecibo`) usa `html2canvas` para convertir el `.card` del recibo ya renderizado en un canvas; `descargarReciboPDF` lo empaqueta en un PDF (`jsPDF`) del mismo tamaño que el contenido; `compartirReciboWhatsApp` lo convierte a PNG y lo pasa a `navigator.share()`. Ambos flujos (venta, abono) llaman a los mismos tres helpers — no hay lógica de render duplicada.

**Tech Stack:** JS plano (ES modules), `html2canvas` y `jsPDF` cargados vía import ESM desde `esm.sh` (mismo patrón que `@supabase/supabase-js`), sin build step.

## Global Constraints

- Sin build step, sin `package.json`, sin `<script>` tags nuevos — todo vía `import` ESM desde `esm.sh`, pineado a versión mayor (`@1`, `@2`), igual que la línea 1 de `app.js`.
- El recibo capturado nunca debe incluir nombre de negocio — se hereda automáticamente porque el PDF/imagen se generan a partir del mismo `.card` que ya está en pantalla, sin agregar texto nuevo.
- El botón "Compartir WhatsApp" nunca genera un link `wa.me` — solo llama `navigator.share({ files: [...] })`; si el navegador no soporta compartir archivos, el botón se oculta por completo (no se muestra ni se le agrega un manejador de error al tocarlo).
- Ninguna de las dos acciones pasa por `assertOnline()` — operan sobre datos ya renderizados localmente, sin llamada de red propia.
- Cancelar el picker nativo de compartir (`AbortError`) nunca dispara un toast de error — es un flujo normal.
- Seguir el estilo visual existente: los botones nuevos usan la clase `.btn-outline` ya definida en `styles.css` (mismo estilo que `#cliente-cancelar`/`#producto-cancelar`).
- No hay framework de pruebas automatizadas en este proyecto — la verificación es manual en navegador, documentando el resultado igual que los tickets anteriores en `TICKETS.md`.

---

### Task 1: Helpers compartidos + PDF/WhatsApp en el recibo de venta

**Files:**
- Modify: `app.js:1` (agregar imports de `html2canvas`/`jsPDF`)
- Modify: `app.js:437-439` (insertar la nueva sección "Recibos: PDF y WhatsApp" entre el fin de Inventario y el inicio de Ventas)
- Modify: `app.js:445` (`let ventaCarrito = ...` — agregar `let ventaReciboFolioActual = null;` junto a las demás variables de estado de Ventas)
- Modify: `app.js:683-715` (`mostrarReciboVenta`)
- Modify: `app.js:717-725` (`initVentas`)
- Modify: `index.html:228-232` (`#venta-paso-recibo`)

**Interfaces:**
- Produces: `capturarRecibo(contenedorEl)` → `Promise<HTMLCanvasElement>`, `descargarReciboPDF(contenedorEl, folio)` → `Promise<void>`, `compartirReciboWhatsApp(contenedorEl, folio)` → `Promise<void>`, `soportaCompartirArchivos()` → `boolean` (síncrona — `navigator.canShare` no es async). Task 2 reutiliza los cuatro sin modificarlos.
- Consumes: `toast()` (`app.js:13`) ya definida.

- [ ] **Step 1: Agregar los imports al inicio de `app.js`**

En `app.js:1`, después del import existente de `supabase-js`:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import html2canvas from 'https://esm.sh/html2canvas@1';
import { jsPDF } from 'https://esm.sh/jspdf@2';
```

- [ ] **Step 2: Agregar la nueva sección de helpers en `app.js`**

Insertar entre la línea 437 (`}` que cierra `initInventario`) y la línea 439 (`// ---------- Ventas ----------`):

```js
// ---------- Recibos: PDF y WhatsApp ----------

async function capturarRecibo(contenedorEl) {
  return html2canvas(contenedorEl, { backgroundColor: '#ffffff', scale: 2 });
}

async function descargarReciboPDF(contenedorEl, folio) {
  let canvas;
  try {
    canvas = await capturarRecibo(contenedorEl);
  } catch (err) {
    toast('No se pudo generar el PDF. Intenta de nuevo.', 'error');
    return;
  }

  const pdf = new jsPDF({ unit: 'px', format: [canvas.width, canvas.height] });
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
  pdf.save(`recibo-${folio}.pdf`);
}

async function compartirReciboWhatsApp(contenedorEl, folio) {
  let canvas;
  try {
    canvas = await capturarRecibo(contenedorEl);
  } catch (err) {
    toast('No se pudo compartir. Intenta de nuevo.', 'error');
    return;
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], `recibo-${folio}.png`, { type: 'image/png' });

  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name === 'AbortError') return; // usuario canceló el picker — no es un error
    toast('No se pudo compartir. Intenta de nuevo.', 'error');
  }
}

function soportaCompartirArchivos() {
  if (!navigator.canShare) return false;
  try {
    const testFile = new File([''], 'test.png', { type: 'image/png' });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Agregar los botones al recibo de venta en `index.html`**

Reemplazar el bloque `#venta-paso-recibo` actual (`index.html:228-232`):

```html
      <!-- Paso: recibo -->
      <div id="venta-paso-recibo" style="display:none;">
        <div class="card" id="venta-recibo-contenido"></div>
        <button id="venta-recibo-cerrar" class="btn btn-primary">Listo</button>
      </div>
```

por:

```html
      <!-- Paso: recibo -->
      <div id="venta-paso-recibo" style="display:none;">
        <div class="card" id="venta-recibo-contenido"></div>
        <button id="venta-recibo-pdf" type="button" class="btn btn-outline">Descargar PDF</button>
        <button id="venta-recibo-whatsapp" type="button" class="btn btn-outline" style="display:none;">Compartir WhatsApp</button>
        <button id="venta-recibo-cerrar" class="btn btn-primary">Listo</button>
      </div>
```

- [ ] **Step 4: Registrar el folio actual y togglear el botón de WhatsApp en `mostrarReciboVenta`**

En `app.js`, dentro de la sección de Ventas, agregar la variable de estado junto a las demás (busca `let ventaCarrito = new Map();` — está a unos renglones después de `// ---------- Ventas ----------`):

```js
let ventaCarrito = new Map(); // producto_id -> { producto, cantidad }
let ventaProductosCache = [];
let ventaTipo = 'contado';
let ventaReciboFolioActual = null;
```

Modificar `mostrarReciboVenta` (`app.js:683-715`) — agregar una línea al inicio y una al final, sin tocar el resto del cuerpo:

```js
function mostrarReciboVenta(info) {
  const cont = document.getElementById('venta-recibo-contenido');
  ventaReciboFolioActual = info.folio;
  const lineasProductos = info.items
    .map(({ producto, cantidad }) => `
      <div class="recibo-linea">
        <span>${cantidad} × ${escapeHtml(producto.nombre)}</span>
        <span>${money.format(Number(producto.precio) * cantidad)}</span>
      </div>
    `)
    .join('');

  const lineasCredito = info.tipo === 'credito'
    ? `
      <div class="recibo-linea"><span>Enganche</span><span>${money.format(info.enganche)}</span></div>
      <div class="recibo-linea"><span>Saldo pendiente del cliente</span><span>${money.format(info.saldoResultante ?? 0)}</span></div>
    `
    : '';

  cont.innerHTML = `
    <div class="recibo-linea"><span>Folio</span><span>${escapeHtml(info.folio)}</span></div>
    <div class="recibo-linea"><span>Fecha</span><span>${fechaFmt.format(info.fecha)}</span></div>
    <div class="recibo-linea"><span>Vendedor</span><span>${escapeHtml(info.vendedor)}</span></div>
    <div class="recibo-linea"><span>Cliente</span><span>${info.cliente ? escapeHtml(info.cliente) : 'Sin cliente'}</span></div>
    <div class="recibo-linea"><span>Tipo</span><span>${info.tipo === 'credito' ? 'Crédito' : 'Contado'}</span></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">
    ${lineasProductos}
    <div class="recibo-linea total"><span>Total</span><span>${money.format(info.total)}</span></div>
    ${lineasCredito}
  `;

  document.getElementById('venta-paso-armar').style.display = 'none';
  document.getElementById('venta-paso-recibo').style.display = 'block';
  document.getElementById('venta-recibo-whatsapp').style.display = soportaCompartirArchivos() ? 'block' : 'none';
}
```

- [ ] **Step 5: Wire los dos botones nuevos en `initVentas`**

Modificar `app.js:717-725`:

```js
function initVentas() {
  document.getElementById('btn-nueva-venta').addEventListener('click', openVentaPanel);
  document.getElementById('venta-cerrar').addEventListener('click', closeVentaPanel);
  document.getElementById('venta-confirmar').addEventListener('click', confirmarVenta);
  document.getElementById('venta-recibo-cerrar').addEventListener('click', closeVentaPanel);
  document.getElementById('venta-recibo-pdf').addEventListener('click', () => {
    descargarReciboPDF(document.getElementById('venta-recibo-contenido'), ventaReciboFolioActual);
  });
  document.getElementById('venta-recibo-whatsapp').addEventListener('click', () => {
    compartirReciboWhatsApp(document.getElementById('venta-recibo-contenido'), ventaReciboFolioActual);
  });
  document.querySelectorAll('.toggle-btn[data-tipo]').forEach((btn) => {
    btn.addEventListener('click', () => setVentaTipo(btn.dataset.tipo));
  });
}
```

- [ ] **Step 6: Verificar en el navegador**

Abrir la app, iniciar sesión con cualquier vendedor, registrar una venta de contado (o crédito) desde "Nueva venta" hasta llegar al paso de recibo.

Expected: aparecen "Descargar PDF" y (si el navegador soporta compartir archivos — Chrome/Edge en desktop normalmente no, la mayoría de navegadores móviles sí) "Compartir WhatsApp" entre la tarjeta del recibo y "Listo". Tocar "Descargar PDF" descarga un archivo `recibo-{folio}.pdf` que, al abrirlo, se ve idéntico al recibo en pantalla (sin márgenes de hoja carta). Si "Compartir WhatsApp" está visible, tocarlo abre el picker nativo de compartir del sistema con una imagen adjunta; cancelar el picker no muestra ningún error. Revisar la consola del navegador: sin errores.

- [ ] **Step 7: Commit**

```bash
git add app.js index.html
git commit -m "Ticket 09: descargar PDF y compartir WhatsApp en recibo de venta"
```

---

### Task 2: PDF/WhatsApp en el recibo de abono

**Files:**
- Modify: `app.js:729` (`let abonoClientesCache = [];` — agregar `let abonoReciboFolioActual = null;`)
- Modify: `app.js:842-856` (`mostrarReciboAbono`)
- Modify: `app.js:858-864` (`initAbonos`)
- Modify: `index.html:265-269` (`#abono-paso-recibo`)

**Interfaces:**
- Consumes: `capturarRecibo`, `descargarReciboPDF`, `compartirReciboWhatsApp`, `soportaCompartirArchivos` — las cuatro funciones definidas en la Task 1, sin modificarlas.

- [ ] **Step 1: Agregar los botones al recibo de abono en `index.html`**

Reemplazar el bloque `#abono-paso-recibo` actual (`index.html:265-269`):

```html
      <!-- Paso: recibo -->
      <div id="abono-paso-recibo" style="display:none;">
        <div class="card" id="abono-recibo-contenido"></div>
        <button id="abono-recibo-cerrar" class="btn btn-primary">Listo</button>
      </div>
```

por:

```html
      <!-- Paso: recibo -->
      <div id="abono-paso-recibo" style="display:none;">
        <div class="card" id="abono-recibo-contenido"></div>
        <button id="abono-recibo-pdf" type="button" class="btn btn-outline">Descargar PDF</button>
        <button id="abono-recibo-whatsapp" type="button" class="btn btn-outline" style="display:none;">Compartir WhatsApp</button>
        <button id="abono-recibo-cerrar" class="btn btn-primary">Listo</button>
      </div>
```

- [ ] **Step 2: Registrar el folio actual y togglear el botón de WhatsApp en `mostrarReciboAbono`**

Agregar la variable de estado en `app.js:729`:

```js
let abonoClientesCache = [];
let abonoReciboFolioActual = null;
```

Modificar `mostrarReciboAbono` (`app.js:842-856`):

```js
function mostrarReciboAbono(info) {
  const cont = document.getElementById('abono-recibo-contenido');
  abonoReciboFolioActual = info.folio;
  cont.innerHTML = `
    <div class="recibo-linea"><span>Folio</span><span>${escapeHtml(info.folio)}</span></div>
    <div class="recibo-linea"><span>Fecha</span><span>${fechaFmt.format(info.fecha)}</span></div>
    <div class="recibo-linea"><span>Vendedor</span><span>${escapeHtml(info.vendedor)}</span></div>
    <div class="recibo-linea"><span>Cliente</span><span>${escapeHtml(info.cliente)}</span></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">
    <div class="recibo-linea total"><span>Monto abonado</span><span>${money.format(info.monto)}</span></div>
    <div class="recibo-linea"><span>Saldo pendiente restante</span><span>${money.format(info.saldoRestante)}</span></div>
  `;

  document.getElementById('abono-paso-armar').style.display = 'none';
  document.getElementById('abono-paso-recibo').style.display = 'block';
  document.getElementById('abono-recibo-whatsapp').style.display = soportaCompartirArchivos() ? 'block' : 'none';
}
```

- [ ] **Step 3: Wire los dos botones nuevos en `initAbonos`**

Modificar `app.js:858-864`:

```js
function initAbonos() {
  document.getElementById('btn-nuevo-abono').addEventListener('click', openAbonoPanel);
  document.getElementById('abono-cerrar').addEventListener('click', closeAbonoPanel);
  document.getElementById('abono-cliente').addEventListener('change', handleAbonoClienteChange);
  document.getElementById('abono-confirmar').addEventListener('click', confirmarAbono);
  document.getElementById('abono-recibo-cerrar').addEventListener('click', closeAbonoPanel);
  document.getElementById('abono-recibo-pdf').addEventListener('click', () => {
    descargarReciboPDF(document.getElementById('abono-recibo-contenido'), abonoReciboFolioActual);
  });
  document.getElementById('abono-recibo-whatsapp').addEventListener('click', () => {
    compartirReciboWhatsApp(document.getElementById('abono-recibo-contenido'), abonoReciboFolioActual);
  });
}
```

- [ ] **Step 4: Verificar en el navegador**

Registrar un abono desde "Nuevo abono" (requiere un cliente con saldo pendiente > 0 — usar uno existente o crear una venta a crédito primero) hasta llegar al paso de recibo.

Expected: mismo comportamiento que el recibo de venta — "Descargar PDF" descarga `recibo-{folio}.pdf` fiel al recibo en pantalla (folio, fecha, vendedor, cliente, monto abonado, saldo restante — sin nombre de negocio), "Compartir WhatsApp" (si el navegador lo soporta) abre el picker nativo. Sin errores en consola.

- [ ] **Step 5: Commit**

```bash
git add app.js index.html
git commit -m "Ticket 09: descargar PDF y compartir WhatsApp en recibo de abono"
```

---

### Task 3: Casos límite, regresión y cierre del ticket

**Files:**
- Modify: `TICKETS.md:217-230` (marcar el ticket 09 como completado, mismo formato que los tickets 01-08)

**Interfaces:**
- Consumes: ninguna nueva — task de verificación y documentación.

- [ ] **Step 1: Verificar el caso de navegador sin soporte de compartir archivos**

En la consola del navegador, antes de generar un recibo, forzar la ausencia de soporte:

```js
Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
```

Generar un recibo (venta o abono) y confirmar que el botón "Compartir WhatsApp" no aparece en absoluto — solo "Descargar PDF" y "Listo". Restaurar recargando la página (no hace falta revertir manualmente, un `location.reload()` limpia el override).

- [ ] **Step 2: Verificar que cancelar el picker de compartir no muestra error**

En un navegador/dispositivo donde el botón sí aparece, tocar "Compartir WhatsApp" y cancelar el picker nativo sin elegir ninguna app. Confirmar que no aparece ningún toast de error y que la app queda en el mismo estado (paso de recibo, sin cambios).

- [ ] **Step 3: Regresión rápida sobre los flujos existentes**

Confirmar que venta de contado, venta a crédito, abono, y el flujo de anular (ticket 08) siguen funcionando exactamente igual que antes — los dos botones nuevos no deben alterar ningún otro comportamiento del panel de recibo (el botón "Listo" sigue cerrando el panel normalmente).

- [ ] **Step 4: Actualizar `TICKETS.md`**

Reemplazar el bloque del ticket 09 (busca `## 09 — Recibos: descarga PDF y compartir WhatsApp`) por:

```markdown
## 09 — Recibos: descarga PDF y compartir WhatsApp ✅

**Blocked by:** 05, 07

**Qué construye:** sobre la vista de recibo ya construida en 05/07, agrega
descarga como PDF y envío directo por WhatsApp.

**Estado:** completado — dos botones nuevos (`.btn-outline`) entre la tarjeta del
recibo y "Listo", tanto en el recibo de venta como en el de abono. `html2canvas`
captura el mismo `.card` que ya está en pantalla (import ESM desde `esm.sh`, sin
build step); "Descargar PDF" lo empaqueta con `jsPDF` en una página del mismo
tamaño que el contenido (sin márgenes de hoja carta); "Compartir WhatsApp" lo
convierte a PNG y lo pasa a `navigator.share()` — el picker nativo del sistema es
quien elige WhatsApp, nunca se genera un link `wa.me`. El botón de WhatsApp se
oculta por completo si el navegador no soporta compartir archivos (`navigator.canShare`).
Probado en navegador: PDF descargado fiel al recibo en pantalla en ambos tipos de
recibo, compartir abre el picker nativo, cancelar el picker no muestra error,
botón de WhatsApp ausente cuando se simula falta de soporte, sin regresión en
los flujos de venta/abono/anulación existentes.

- [x] Botón "Descargar PDF" (`html2canvas` + `jsPDF`) — fiel al recibo en
      pantalla
- [x] Botón "Compartir WhatsApp" vía Web Share API (no genera link `wa.me`)
- [x] Ambos disponibles tanto en recibo de venta como de abono
- [x] Sin nombre de negocio en ningún lado del recibo
```

- [ ] **Step 5: Confirmar el resultado y commit**

Releer `TICKETS.md` completo y confirmar que el ticket 09 quedó con el mismo formato visual que los tickets 01-08 inmediatamente anteriores.

```bash
git add TICKETS.md
git commit -m "Ticket 09: cierre — actualizar TICKETS.md"
```
