# Diseño — Ticket 09: Recibos — descarga PDF y compartir WhatsApp

> Ver [TICKETS.md](../../../TICKETS.md) (ticket 09) y [SPEC.md](../../../SPEC.md)
> (sección 8) para el contexto original.

## Contexto

Los tickets 05 y 07 ya construyeron la vista de recibo en pantalla:
`mostrarReciboVenta()`/`mostrarReciboAbono()` en `app.js` rellenan
`#venta-recibo-contenido`/`#abono-recibo-contenido` (ambos `.card`) con el
folio, fecha, vendedor, cliente, items/monto y — para crédito — enganche y
saldo pendiente. Ninguno de los dos incluye nombre de negocio en ningún
lado. Este ticket agrega, sobre esa misma vista, la posibilidad de
descargarla como PDF o compartirla directo por WhatsApp — sin tocar la
lógica de negocio (`registrar_venta`, `registrar_abono`, `anular_venta`,
`anular_abono` quedan intactas).

## Decisiones tomadas en esta sesión

1. **Compartir WhatsApp comparte una imagen PNG**, no el PDF — en WhatsApp
   una imagen se previsualiza directo en el chat; un PDF llega como
   documento adjunto sin preview. Ambos formatos se generan a partir de la
   misma captura (`html2canvas`), así que no hay duplicación de lógica de
   render.
2. **El PDF usa una página ajustada al contenido**, no tamaño carta/A4 — la
   página mide exactamente el ancho/alto del recibo capturado, para que se
   vea idéntico a la pantalla sin márgenes blancos de una hoja de oficina.
3. **El botón "Compartir WhatsApp" se oculta por completo** (no se muestra
   con un error al tocarlo) cuando el navegador no soporta compartir
   archivos vía Web Share API — se detecta una vez al mostrar el recibo con
   `navigator.canShare?.({ files: [...] })`. Solo queda "Descargar PDF" en
   ese caso, que sí funciona en cualquier navegador moderno.

## 1. Librerías

Sin build step — mismo patrón ya usado por `supabase-js` (import ESM
directo desde `esm.sh`, pineado a versión mayor únicamente):

```js
import html2canvas from 'https://esm.sh/html2canvas@1';
import { jsPDF } from 'https://esm.sh/jspdf@2';
```

No se agregan `<script>` tags, no se agrega `package.json`, no cambia el
flujo de despliegue (que hoy es servir los archivos estáticos tal cual).

## 2. Captura del recibo

Función compartida (nueva, en la sección de `app.js` donde ya viven
`mostrarReciboVenta`/`mostrarReciboAbono`):

```js
async function capturarRecibo(contenedorEl) {
  return html2canvas(contenedorEl, { backgroundColor: '#ffffff', scale: 2 });
}
```

`scale: 2` para que el PDF/imagen se vea nítido en pantallas de alta
densidad (el recibo es texto pequeño). Se captura siempre el mismo
elemento `.card` que ya está en pantalla — cero lógica de render
duplicada, y la regla "sin nombre de negocio en el recibo" se hereda
automáticamente porque la fuente es la misma vista que ya cumple esa
regla.

## 3. Descargar PDF

```js
async function descargarReciboPDF(contenedorEl, folio) {
  const canvas = await capturarRecibo(contenedorEl);
  const pdf = new jsPDF({
    unit: 'px',
    format: [canvas.width, canvas.height],
  });
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
  pdf.save(`recibo-${folio}.pdf`);
}
```

Sin llamada de red — es una operación local sobre lo que ya está en
pantalla, así que no pasa por `assertOnline()`.

## 4. Compartir WhatsApp

```js
async function compartirReciboWhatsApp(contenedorEl, folio) {
  const canvas = await capturarRecibo(contenedorEl);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], `recibo-${folio}.png`, { type: 'image/png' });

  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name === 'AbortError') return; // usuario canceló el picker — no es un error
    toast('No se pudo compartir. Intenta de nuevo.', 'error');
  }
}
```

`navigator.share({ files: [...] })` abre el picker nativo del sistema —
WhatsApp es una de las opciones que el usuario elige ahí, nunca se genera
un link `wa.me` ni se abre WhatsApp directamente desde el código.

**Detección de soporte** (una vez, al mostrar el recibo):

```js
async function soportaCompartirArchivos() {
  if (!navigator.canShare) return false;
  const testFile = new File([''], 'test.png', { type: 'image/png' });
  return navigator.canShare({ files: [testFile] });
}
```

`mostrarReciboVenta`/`mostrarReciboAbono` llaman esto al final y togglean
`display` del botón "Compartir WhatsApp" según el resultado.

## 5. UI

En ambos pasos de recibo (`index.html`), dos botones `.btn-outline` nuevos
entre la tarjeta del recibo y el botón "Listo" existente:

```html
<!-- Paso: recibo -->
<div id="venta-paso-recibo" style="display:none;">
  <div class="card" id="venta-recibo-contenido"></div>
  <button id="venta-recibo-pdf" type="button" class="btn btn-outline">Descargar PDF</button>
  <button id="venta-recibo-whatsapp" type="button" class="btn btn-outline" style="display:none;">Compartir WhatsApp</button>
  <button id="venta-recibo-cerrar" class="btn btn-primary">Listo</button>
</div>
```

Mismo patrón exacto en `#abono-paso-recibo` (IDs con prefijo `abono-` en
vez de `venta-`). "Listo" sigue siendo el único botón primario (cierra el
panel); los otros dos son acciones secundarias, mismo estilo `.btn-outline`
ya usado en los formularios de cliente/producto (`#cliente-cancelar`,
`#producto-cancelar`).

## 6. Errores

- Fallo de `html2canvas`/`jsPDF` al generar el PDF: toast "No se pudo
  generar el PDF. Intenta de nuevo."
- Fallo de `compartirReciboWhatsApp` (que no sea cancelación del usuario):
  toast "No se pudo compartir. Intenta de nuevo."
- Ninguna de las dos operaciones requiere conexión a internet ni pasa por
  `assertOnline()` — trabajan sobre el recibo ya renderizado localmente.

## Fuera de alcance

- No se agrega descarga/compartir desde la pantalla de Historial (ticket
  08) — ahí no hay una vista de recibo completa, solo la lista resumida.
  Si se quisiera reabrir el recibo completo de un movimiento pasado desde
  Historial, sería un ticket aparte.
- No se genera un recibo combinado/consolidado — cada botón opera sobre un
  único recibo (el que está en pantalla en ese momento).
