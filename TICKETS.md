# TICKETS — PWA "Ventas Familia"

> Desglose de [SPEC.md](SPEC.md) en tickets de corte vertical (cada uno cruza
> esquema + backend + UI y es demostrable por sí solo). Borrador pendiente de
> aprobación — ningún archivo de código existe todavía.

---

## 01 — Fundación: esquema de Supabase + funciones core ✅

**Blocked by:** Ninguno — puede iniciar de inmediato.

**Qué construye:** la base de datos y funciones SQL de las que depende todo lo demás.
No es demostrable en UI por sí solo (es prefactoring), pero desbloquea todos los
módulos.

**Estado:** completado en proyecto Supabase `ventas-familia` (ref `wiewxgkiefsjeonirsid`,
región us-east-1, org Ciegus). RLS queda deshabilitado a propósito (fuera de alcance v1,
sección 13 del SPEC) — advertido y confirmado.

- [x] Tablas: `usuarios` (nombre, rol admin/vendedor, password_hash), `clientes`
      (nombre único, teléfono opcional, saldo_pendiente), `productos` (nombre,
      precio, foto_url, stock), `ventas` (folio, tipo contado/crédito, cliente_id
      nullable, vendedor_id, total, enganche, anulado, anulado_por, anulado_en,
      creado_en), `venta_items` (venta_id, producto_id, cantidad, precio_unitario
      snapshot), `abonos` (folio, cliente_id, vendedor_id, monto, anulado,
      anulado_por, anulado_en, creado_en)
- [x] Función `generate_folio()` — formato `REC-XXXXXXXX`, reintenta hasta
      garantizar unicidad (verificada contra `ventas` y `abonos`)
- [x] Constraint `UNIQUE` en folio de `ventas` y de `abonos`
- [x] Función `login_usuario()` `SECURITY DEFINER` — verifica nombre + contraseña
      contra hash `bcrypt`/`pgcrypto`, nunca expone el hash vía RLS pública.
      Probada: login correcto devuelve fila, login incorrecto no devuelve nada.
- [x] Bucket de Storage `productos` (público, solo lectura de imágenes) para fotos
- [x] Sembrados los 4 usuarios fijos (Papá-admin, Angie/Alexa/Alexis-vendedor) con
      contraseña temporal `2026` — **pendiente que cada quien la cambie más adelante**

**Ajuste (2026-07-26):** se agregó `categoria text` (opcional) a `productos` — ver
SPEC sección 15. También se agregaron políticas RLS abiertas (select/insert/update/
delete para `anon`/`authenticated`) en `storage.objects` para el bucket `productos` —
el bucket "público" solo controla lectura vía URL, subir/editar/borrar archivos
requiere políticas propias aunque el resto de las tablas no use RLS.

---

## 02 — PWA shell + login ✅

**Blocked by:** 01

**Qué construye:** cualquiera de los 4 usuarios puede instalar la app, entrar con
su nombre + contraseña y quedar logueado.

**Estado:** completado — `index.html`, `app.js`, `styles.css`, `sw.js`,
`manifest.json`, `icon.svg` en el directorio del proyecto. Probado en navegador
(desktop y viewport móvil): login correcto, contraseña incorrecta rechazada,
sesión persiste al recargar, logout, Service Worker activo, bloqueo con aviso
claro al simular `navigator.onLine = false`.

- [x] `manifest.json` + Service Worker (shell instalable/cacheable — sin cola
      offline de escritura)
- [x] Pantalla login: selección de nombre (lista fija de 4) + contraseña, llama a
      la función `SECURITY DEFINER` (`login_usuario`)
- [x] Sesión persistida (localStorage) + logout
- [x] Verificación de conexión antes de cualquier operación de escritura — error
      claro si no hay internet, nunca falla en silencio ni encola

**Rework (2026-07-26, ver SPEC sección 15):** re-branding a "Lima's Sales" (logo LS,
paleta teal/navy) en login, header y manifest; se agregó la barra de navegación
inferior de 4 pestañas (Inicio/Inventario/Clientes/Reportes) con sus 4 paneles
placeholder. Reprobado en navegador: login, sesión persistida, logout y las 4
pestañas cambian correctamente.

---

## 03 — Módulo Clientes ✅

**Blocked by:** 02

**Qué construye:** alta y listado de clientes, visible para los 4 usuarios.

**Estado:** completado — pestaña Clientes con lista, FAB (+) para alta, bottom sheet
de formulario reutilizado para alta/edición. Probado en navegador: lista vacía inicial,
alta de cliente, bloqueo de nombre duplicado con el mensaje de apodo/inicial, edición
con datos precargados, badge de saldo ("Al día" en verde / monto en rojo cuando hay
saldo pendiente > 0).

- [x] Alta de cliente: nombre obligatorio y único (bloquea duplicado exacto con
      mensaje claro para diferenciarlo con apodo/inicial), teléfono opcional
- [x] Listado de clientes con su saldo pendiente actual
- [x] Edición de datos del cliente (nombre, teléfono)

---

## 04 — Módulo Inventario ✅

**Blocked by:** 02

**Qué construye:** alta y listado de productos, con foto y precio obligatorios.

**Estado:** completado — pestaña Inventario con grid de 2 columnas, chips de filtro
por categoría (solo aparecen si hay categorías capturadas), FAB (+) y bottom sheet con
subida de foto a Storage. Probado en navegador: bloqueo al guardar sin foto, subida de
foto y guardado exitoso, chips de categoría generados dinámicamente y filtrando
correctamente, edición sin necesidad de resubir foto, validación de precio ≤ 0 y de
stock no entero/negativo.

- [x] Alta de producto: nombre, precio (obligatorio), foto (obligatoria, sube al
      bucket de Storage), stock entero ≥ 0 (obligatorio), categoría (texto libre,
      opcional) — no se puede guardar sin foto o sin precio
- [x] Listado de productos con stock actual, visible para todos; permite
      agrupar/filtrar por categoría cuando el producto la tiene
- [x] Edición de producto (precio, stock, foto, categoría)

---

## 05 — Venta de contado ✅

**Blocked by:** 03, 04

**Qué construye:** flujo completo de venta de contado, de la selección de
productos al recibo en pantalla.

**Estado:** completado — botón "Nueva venta" en Inicio abre panel fullscreen con
selector de productos (tap para agregar, +/− en carrito), cliente opcional, total en
vivo, y recibo en pantalla al confirmar. La lógica de negocio vive en la función SQL
`registrar_venta()` (ver ticket 01/migraciones) — valida stock con lock atómico,
genera folio, inserta venta + items y descuenta stock en una sola transacción; también
soporta `tipo='credito'` para que el ticket 06 la reutilice sin duplicar lógica.
Probado en navegador: carrito con 2 productos, bloqueo al intentar exceder stock,
venta confirmada con cliente asociado, recibo correcto (folio/fecha/vendedor/
cliente/items/total), stock descontado en BD, saldo del cliente sin tocar (contado),
reapertura del panel resetea carrito y refleja stock actualizado, bloqueo claro sin
conexión.

- [x] Selección de 1+ productos con cantidad — valida stock disponible y bloquea
      si la cantidad pedida lo supera (sin opción de "vender igual")
- [x] Cliente opcional en venta de contado
- [x] Vendedor = usuario logueado (nunca campo elegible)
- [x] Al confirmar: genera folio, descuenta stock de inmediato
- [x] Recibo en pantalla: folio, fecha/hora, vendedor, cliente (si hay),
      productos/cantidad/precio unitario, total
- [x] Sin conexión al confirmar → bloquea con error claro

---

## 06 — Venta a crédito ✅

**Blocked by:** 05

**Qué construye:** extiende el flujo de venta con el tipo crédito — cliente
obligatorio, enganche opcional, saldo global del cliente actualizado.

**Estado:** completado — toggle Contado/Crédito en el panel de venta; al elegir
Crédito, el cliente pasa a obligatorio y aparece el campo de enganche. Reutiliza la
misma función `registrar_venta()` del ticket 05 (ya soportaba `tipo`/`enganche`), sin
tocar SQL. Probado en navegador: bloqueo sin cliente, bloqueo de enganche negativo y
de enganche mayor al total, venta a crédito con enganche $300 sobre total $1,000 →
saldo del cliente $700 correcto tanto en el recibo como en la base de datos, reset del
toggle a "Contado" al reabrir el panel.

- [x] Selector contado/crédito al capturar (no cambia después de creada)
- [x] Crédito requiere cliente (bloquea confirmar sin cliente)
- [x] Enganche opcional, capturable entre $0 y el total
- [x] `(total − enganche)` se suma al saldo global del cliente (no aislado por
      venta)
- [x] Recibo incluye enganche y saldo pendiente resultante del cliente
- [x] Nunca genera recargos ni intereses — el saldo queda fijo desde su creación

---

## 07 — Abonos ✅

**Blocked by:** 06

**Qué construye:** cualquier vendedor registra un abono contra la cuenta global de
cualquier cliente con saldo pendiente.

**Estado:** completado — botón "Nuevo abono" en Inicio abre panel fullscreen: select
de clientes (solo los que tienen saldo > 0, con el saldo mostrado en cada opción),
monto y recibo. Lógica atómica en la función SQL `registrar_abono()` — bloquea la
fila del cliente, valida servidor-side que el monto no exceda el saldo (autoritativo,
no solo validación de UI) y descuenta. Probado en navegador: lista solo muestra
clientes con saldo > 0, bloqueo de monto mayor al saldo con mensaje claro, abono de
$150 sobre saldo $500 → recibo y BD coinciden en saldo restante $350, el select se
refresca con el saldo actualizado al reabrir, bloqueo claro sin conexión.

- [x] Selección de cliente (con saldo pendiente > 0) — cualquier vendedor puede
      abonar a cualquier cliente, no solo quien hizo la venta original
- [x] Monto: rechaza captura si es mayor al saldo pendiente actual, con mensaje
      claro (no existe saldo a favor)
- [x] Al confirmar: genera folio (mismo formato `REC-XXXXXXXX`), reduce el saldo
      del cliente
- [x] Recibo: folio, fecha/hora, vendedor, cliente, monto abonado, saldo
      pendiente restante

---

## 08 — Anulaciones ✅

**Blocked by:** 06, 07

**Qué construye:** reversión correcta de ventas y abonos, con permisos
diferenciados por rol.

**Estado:** completado — pantalla nueva "Historial" (tercer botón de acción rápida
en Inicio, panel fullscreen) con lista combinada de ventas + abonos, chips
Todos/Ventas/Abonos, y botón "Anular" visible solo para el vendedor dueño del
registro o para Papá (admin). Lógica atómica en las funciones SQL `anular_venta()`
y `anular_abono()` — mismo patrón `SECURITY DEFINER` que `registrar_venta()`/
`registrar_abono()`. Probado en navegador: anular venta de contado repone stock,
anular venta a crédito repone stock y resta el saldo pendiente correcto, anular
abono suma el monto de vuelta al saldo, permisos correctos por rol (vendedor solo
ve "Anular" en lo suyo, Papá lo ve en todo), doble anulación rechazada, sin
conexión bloquea con error claro.

- [x] Botón "Anular" en historial de ventas/abonos — visible según permisos:
      vendedor solo ve el suyo, Papá (admin) ve cualquiera
- [x] Anular **abono**: revierte, suma el monto de vuelta al saldo del cliente
- [x] Anular **venta a crédito**: resta del saldo global lo que había quedado
      pendiente de esa venta; los abonos ya aplicados a la cuenta no se tocan.
      **Caso límite agregado:** si eso dejaría el saldo negativo (el cliente ya
      abonó de más contra esa cuenta), la anulación se bloquea con mensaje claro
      en vez de permitir un saldo negativo (ver
      [docs/superpowers/specs/2026-07-27-anulaciones-design.md](docs/superpowers/specs/2026-07-27-anulaciones-design.md))
- [x] Anular **venta de contado**: repone el stock vendido (mercancía nunca salió
      realmente), no toca ningún saldo
- [x] Nunca se borra físicamente — se marca `anulado`, `anulado_por`,
      `anulado_en`

---

## 09 — Recibos: descarga PDF y compartir WhatsApp

**Blocked by:** 05, 07

**Qué construye:** sobre la vista de recibo ya construida en 05/07, agrega
descarga como PDF y envío directo por WhatsApp.

- [ ] Botón "Descargar PDF" (`html2canvas` + `jsPDF`) — fiel al recibo en
      pantalla
- [ ] Botón "Compartir WhatsApp" vía Web Share API (no genera link `wa.me`)
- [ ] Ambos disponibles tanto en recibo de venta como de abono
- [ ] Sin nombre de negocio en ningún lado del recibo

---

## 10 — Dashboard principal

**Blocked by:** 06, 07

**Qué construye:** pantalla de inicio combinada, idéntica para los 4 usuarios.

- [ ] Ventas y abonos del día (de todo el negocio, no solo del usuario logueado)
- [ ] Clientes con saldo pendiente (para saber a quién cobrar)
- [ ] Accesos rápidos: "Nueva venta", "Nuevo abono"

---

## 11 — Reportes

**Blocked by:** 08

**Qué construye:** reportes de negocio, sin restricción de datos por rol.

- [ ] Total vendido (contado + crédito) por período
- [ ] Saldo total pendiente del negocio (suma de saldos de todos los clientes)
- [ ] Listado de clientes con saldo pendiente, de mayor a menor
- [ ] Ventas y abonos agrupados por vendedor (visible para todos)
- [ ] Solo tablas/texto — sin gráficas (fuera de alcance v1)
