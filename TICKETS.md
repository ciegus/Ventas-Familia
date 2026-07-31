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
recibo, botón de WhatsApp ausente cuando se simula falta de soporte, cancelar el
picker (`AbortError` simulado) no muestra error, sin regresión en los flujos de
venta/abono/anulación existentes. La invocación de `navigator.share()` está
integrada según la API estándar, pero completar un compartir real hacia WhatsApp
(picker nativo abriéndose y la app recibiendo el archivo) no se verificó en
dispositivo real — falta esa prueba puntual en un teléfono antes de confiar el
flujo al 100% en producción.

- [x] Botón "Descargar PDF" (`html2canvas` + `jsPDF`) — fiel al recibo en
      pantalla
- [x] Botón "Compartir WhatsApp" vía Web Share API (no genera link `wa.me`)
- [x] Ambos disponibles tanto en recibo de venta como de abono
- [x] Sin nombre de negocio en ningún lado del recibo

---

## 10 — Dashboard principal ✅

**Blocked by:** 06, 07

**Qué construye:** pantalla de inicio combinada, idéntica para los 4 usuarios.

**Estado:** completado — pestaña Inicio agrega, debajo de los accesos rápidos ya
existentes, dos tarjetas de estadística ("Ventas de hoy" / "Abonos de hoy" con monto
total y contador, excluyendo registros anulados) y la lista "Clientes con saldo
pendiente" (ordenada de mayor a menor saldo). `loadDashboard()` se dispara al entrar
a la pestaña Inicio (mismo patrón que `loadClientes()`/`loadProductos()` en las otras
pestañas) y también se refresca inmediatamente tras confirmar una venta, un abono o
una anulación, para que el usuario no vea números viejos al volver a Inicio sin
cambiar de pestaña. "Hoy" se calcula con la medianoche local del dispositivo.
Probado en navegador: cifras coinciden con los datos reales en Supabase (8 ventas
$2,250.00 / 5 abonos $800.00 / cliente con saldo $250.00), estilos de las tarjetas
aplicados correctamente, sin errores de consola, refresco correcto al cambiar de
pestaña y volver.

- [x] Ventas y abonos del día (de todo el negocio, no solo del usuario logueado)
- [x] Clientes con saldo pendiente (para saber a quién cobrar)
- [x] Accesos rápidos: "Nueva venta", "Nuevo abono"

---

## 11 — Reportes ✅

**Blocked by:** 08

**Qué construye:** reportes de negocio, sin restricción de datos por rol —
además del alcance original del SPEC, agrega el cálculo de ganancia neta por
vendedor (ver [docs/superpowers/specs/2026-07-30-ganancia-por-vendedor-design.md](docs/superpowers/specs/2026-07-30-ganancia-por-vendedor-design.md)).

**Estado:** completado — pestaña Reportes con selector de mes, tarjetas de
total vendido y ganancia neta del periodo, saldo pendiente del negocio y
listado de clientes con saldo (corte a hoy), tabla por vendedor (vendido/
abonado/ganancia neta) y detalle artículo por artículo (costo, precio, %
utilidad). Se agregó `productos.costo` (obligatorio), snapshot de costo en
`venta_items`/`ventas`, y una nueva tabla `venta_pagos` que registra cada
cobro real (enganche/contado o abono aplicado vía reparto FIFO) con su
ganancia, atribuida siempre al vendedor original de la venta — no a quien
cobra un abono ajeno. El precio de venta se volvió editable por línea en el
carrito (antes era fijo del catálogo); el costo del producto se oculta por
default en Inventario y en el carrito, con botón para revelarlo — en
Reportes se muestra siempre, sin ocultar. `anular_venta()` de crédito ya no
bloquea si el cliente ya abonó contra esa venta: descuenta solo lo que le
quedaba pendiente a esa venta específica y conserva la ganancia ya
realizada. Probado en navegador: campo costo obligatorio con bloqueo
correcto, oculto/revelado en Inventario y carrito, precio editable por línea
con total/subtotal en vivo, venta de contado y a crédito con precio editado
generan folio/recibo/saldo correctos, Reportes recalcula al cambiar de mes
(incluyendo el caso sin datos), ventas históricas previas a la migración
muestran costo $0/100% utilidad (limitación esperada y documentada, no hay
costo histórico que reconstruir), una venta nueva con costo real refleja el
% de utilidad y la ganancia por vendedor correctos. Verificado directamente
en Supabase con pruebas SQL para las 4 funciones reescritas (incluyendo el
reparto FIFO entre vendedores distintos y la reversión de anulaciones), sin
dejar datos de prueba.

- [x] Total vendido (contado + crédito) por período
- [x] Saldo total pendiente del negocio (suma de saldos de todos los clientes)
- [x] Listado de clientes con saldo pendiente, de mayor a menor
- [x] Ventas y abonos agrupados por vendedor (visible para todos)
- [x] Ganancia neta por vendedor, realizada solo sobre lo efectivamente cobrado
- [x] Solo tablas/texto — sin gráficas

---

## 12 — Gestión de usuarios ✅

**Blocked by:** Ninguno

**Qué construye:** alta/edición/desactivación de usuarios desde la propia app
(antes eran 4 usuarios fijos sembrados a mano en Supabase). Primer
sub-proyecto de dos — desbloquea el ticket 13 (multi-almacén).

**Estado:** completado — pantalla nueva "Mi cuenta" (ícono 👤 en el topbar,
panel fullscreen) con dos secciones: "Mi cuenta" (todos los roles, cambio de
contraseña con la actual + nueva + confirmar) y "Usuarios" (solo admin,
lista con badge Activo/Inactivo, alta con nombre + contraseña inicial + rol,
edición con reseteo de contraseña opcional y toggle de estatus). Login ya no
tiene una lista fija — se puebla dinámicamente desde `usuarios where
activo = true`. Cuatro funciones SQL nuevas (`crear_usuario`,
`cambiar_contrasena`, `admin_resetear_password`, `cambiar_estatus_usuario`) y
un refuerzo de una línea en `login_usuario()` (rechaza usuarios inactivos).
Las 5 funciones SQL se probaron en vivo contra Supabase (alta, login
bloqueado/permitido según `activo`, cambio de contraseña propio y por admin,
salvaguarda del último admin). El frontend (login dinámico, panel "Mi
cuenta", sección "Usuarios") se implementó y se verificó de forma estática
(sintaxis, IDs/clases cruzados contra el HTML/CSS, trazado de lógica) —
**pendiente que Luis lo pruebe manualmente en el navegador** antes de darlo
por completamente cerrado (no hubo herramienta de automatización de
navegador disponible en esta sesión).

- [x] Solo `admin` gestiona usuarios (puede haber varios); baja = desactivar
      (`usuarios.activo`), nunca borrar — reactivable
- [x] Salvaguarda: nunca se permite desactivar al último admin activo
- [x] Contraseña: autoservicio (requiere la actual) + reseteo directo por
      admin (sin requerir la anterior)
- [x] Pantalla "Mi cuenta" nueva, accesible desde ícono en topbar — todos ven
      cambio de contraseña; solo admin ve gestión de usuarios
- [x] Login poblado dinámicamente desde `usuarios where activo = true`
- [x] Confirmado sin cambio de código: un admin ya puede vender hoy

---

## 13 — Inventario multi-almacén ✅

**Blocked by:** 12 (completado)

**Qué construye:** reemplaza `productos.stock` (un solo número global) por stock
distribuido: un almacén central ("Central") y un almacén propio por cada usuario
(incluido el admin), con trazabilidad completa de toda entrada y traspaso.

**Estado:** completado — tres tablas nuevas (`almacenes`, `stock_almacen`,
`movimientos_almacen`), cuatro funciones SQL nuevas (`crear_producto`,
`registrar_entrada`, `registrar_traspaso`, `anular_movimiento`) y rework de tres
funciones existentes (`registrar_venta`, `anular_venta` — leen/escriben el almacén del
vendedor en vez de un total global; `crear_usuario` — crea el almacén del usuario nuevo
en la misma operación). Frontend: Inventario gana "Stock por almacén" de solo lectura +
botón "Registrar entrada" (admin); el carrito de venta solo muestra lo que el vendedor
logueado trae en su propio almacén; pantalla nueva "📦 Movimientos" (acceso rápido en
Inicio) con historial visible para todos y alta/anulación solo para admin. Probado con
SQL directo y en navegador: alta de producto con stock inicial genera su entrada a
Central automáticamente, traspasos entre cualquier par de almacenes (incluido
vendedor→vendedor directo sin pasar por Central), un vendedor no puede vender más de lo
que tiene en su propio almacén aunque Central tenga de sobra, anular una venta repone al
almacén del vendedor de esa venta (no a Central), anular un traspaso se bloquea si el
destino ya no tiene suficiente para revertir, anular una entrada resta de Central sin
"origen" que restaurar, solo admin ve los controles de movimientos (todos ven el
historial).

Regresión de cierre (Task 13) en navegador real contra Supabase en vivo: traspaso
Central→Angie de 5 unidades reflejado correctamente en Inventario ("Stock por almacén")
y en el carrito de Angie ("Stock disponible"), venta de contado de 2 unidades descontó
solo del almacén de Angie (Central intacto), anulación de esa venta repuso las 2
unidades al almacén de Angie (no a Central), traspaso inverso Angie→Central dejó el
stock exactamente como al inicio del ticket (Central 46 / resto en 0). También se
verificó sin regresión: login (los 4 usuarios activos), Historial con permisos de
anulación por rol, panel "Mi cuenta"/"Usuarios" (ticket 12) y Reportes con las cifras
recalculadas — sin errores en consola del navegador durante toda la sesión. No quedó
ningún dato de prueba con nombre "Test %"/"Prueba QA" en `productos` ni `usuarios`.

- [x] Esquema: `almacenes`, `stock_almacen`, `movimientos_almacen`
- [x] `registrar_entrada()`, `registrar_traspaso()`, `anular_movimiento()`
- [x] `crear_producto()` (alta con stock inicial atómico, ya no insert directo)
- [x] Rework de `registrar_venta()`/`anular_venta()` (almacén del vendedor)
- [x] Inventario: stock por almacén (solo lectura) + botón "Registrar entrada"
- [x] Carrito de venta: lista solo lo que el vendedor trae en su propio almacén
- [x] Pantalla nueva "📦 Movimientos" con permisos admin/todos

**Ajustes post-cierre (mismo día, tras review final):** se encontró y corrigió un
movimiento de prueba mal revertido que dejaba un botón "Anular" capaz de borrar 20
unidades reales de Central de un clic (ya corregido, sin impacto real). Además, por
decisión de Luis: (1) el nombre de un almacén de vendedor ya no se guarda duplicado —
se resuelve en vivo desde `usuarios.nombre` vía join, así que renombrar a alguien
(sección "Mi cuenta") se refleja de inmediato en Inventario y Movimientos sin que quede
desactualizado; (2) `crear_producto()` ahora exige rol `admin` (antes cualquier
vendedor podía dar de alta stock de la nada) — el botón "+" de Inventario ya no se
muestra a vendedores; (3) se eliminaron 8 ventas de prueba del 2026-07-27 (previas a
este ticket, detectadas en el review final) que habrían repuesto stock al almacén
equivocado si alguna vez se anulaban.
