# Diseño — Ticket 13: Inventario multi-almacén

> Segundo de dos sub-proyectos (ver
> [2026-07-30-gestion-usuarios-design.md](2026-07-30-gestion-usuarios-design.md)
> para el primero, del que este depende: cada usuario necesita existir en
> la app antes de que se le cree su almacén personal). Reemplaza el modelo
> actual de `productos.stock` como un único número global por uno de stock
> distribuido: un almacén central ("Casa") y un almacén personal por cada
> usuario (incluido el admin), con trazabilidad completa de toda entrada y
> traspaso.

## 1. Contexto y decisiones tomadas en esta sesión

1. **Un almacén por usuario, más Central:** Central no le pertenece a nadie
   (`usuario_id null`); cada usuario — vendedor o admin — tiene exactamente
   un almacén propio. Un admin también vende desde su propio almacén, no
   directamente desde Central.
2. **Solo admin registra movimientos:** entradas y traspasos siempre los
   registra un usuario con rol `admin`. Un vendedor no puede moverle stock
   a otro ni a sí mismo.
3. **Traspasos entre cualquier par de almacenes:** no es obligatorio pasar
   por Central — un traspaso puede ir Central→vendedor, vendedor→Central, o
   vendedor→vendedor directo.
4. **Mercancía nueva siempre entra a Central primero.** No existe "entrada
   directa" a un almacén de vendedor — si llega mercancía nueva, entra a
   Central y de ahí se traspasa.
5. **Una venta siempre descuenta del almacén propio de quien vende** — el
   carrito no permite elegir otro almacén. Esto es automático a partir de
   `ventas.vendedor_id` (cada usuario tiene un único almacén propio, así que
   no hace falta un campo adicional para saberlo).
6. **Reposición de stock de un producto existente:** ya no se edita un
   campo "Stock" a mano. Se usa un botón "Registrar entrada" aparte,
   siempre con destino Central, que queda como movimiento auditable.
7. **Alta de producto nuevo:** el formulario sigue pidiendo una cantidad de
   "stock inicial" — esa cantidad se registra automáticamente como la
   primera entrada del producto (a Central), en la misma operación atómica
   que crea el producto.
8. **Dónde se ven los movimientos:** acceso rápido nuevo y separado en
   Inicio ("📦 Movimientos"), no mezclado con el Historial de ventas/abonos
   existente. Todos los usuarios pueden **ver** el historial completo de
   movimientos (transparencia, consistente con "todos ven todo" — SPEC
   sección 1); solo admin ve los controles para crear/anular.
9. **Anular un movimiento — con una diferencia importante respecto a
   ticket 11:** si el almacén destino de ese movimiento ya no tiene
   suficiente cantidad para revertirlo (porque ya se vendió o se volvió a
   traspasar), la anulación **se bloquea** con mensaje claro. A diferencia
   de `anular_venta()` (ticket 11, que ya no bloquea y solo resta lo que
   queda pendiente), aquí no aplica ese mismo criterio: una venta es dinero
   (se puede razonar en parciales), pero un movimiento de almacén son
   **unidades físicas reales** — no existe "anular parcialmente" 5 de 10
   playeras si esas 10 ya no están ahí. Bloquear es lo único correcto.
10. **Desactivar un usuario no mueve su stock.** Su almacén y lo que tenía
    asignado se quedan exactamente igual — si se quiere recuperar esa
    mercancía, el flujo recomendado es primero traspasarla a Central y
    **después** desactivar al usuario (ticket 12).

## 2. Esquema — cambios en Supabase

```sql
-- Almacenes: Central (usuario_id null) + uno por usuario
create table almacenes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  usuario_id uuid references usuarios(id),
  creado_en timestamptz not null default now()
);
create unique index almacenes_usuario_id_unique_idx on almacenes(usuario_id) where usuario_id is not null;
insert into almacenes (nombre, usuario_id) values ('Central', null);
insert into almacenes (nombre, usuario_id)
  select nombre, id from usuarios; -- un almacén por cada usuario ya existente

-- Stock distribuido por almacén — reemplaza productos.stock
create table stock_almacen (
  producto_id uuid not null references productos(id),
  almacen_id uuid not null references almacenes(id),
  cantidad integer not null default 0 check (cantidad >= 0),
  primary key (producto_id, almacen_id)
);
-- Backfill: el stock actual de cada producto se asigna a Central (no hay forma
-- de saber si ya estaba repartido entre vendedores en el modelo viejo).
insert into stock_almacen (producto_id, almacen_id, cantidad)
select p.id, (select id from almacenes where nombre = 'Central'), p.stock
from productos p;

alter table productos drop column stock;

-- Movimientos: entrada (origen null, siempre a Central) o traspaso (origen no null)
create table movimientos_almacen (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid not null references productos(id),
  almacen_origen_id uuid references almacenes(id),
  almacen_destino_id uuid not null references almacenes(id),
  cantidad integer not null check (cantidad > 0),
  usuario_id uuid not null references usuarios(id),
  anulado boolean not null default false,
  anulado_por uuid references usuarios(id),
  anulado_en timestamptz,
  creado_en timestamptz not null default now()
);
create index movimientos_almacen_producto_id_idx on movimientos_almacen(producto_id);
```

**Nota de migración de datos:** el stock que hoy tiene el único producto
("Playera polo azul", 46 unidades tras la limpieza del ticket 11) se asigna
completo a Central al migrar — no hay forma de reconstruir si en la
realidad ya estaba repartido entre vendedores; **Luis deberá registrar los
traspasos reales manualmente después de la migración** para que el
desglose por almacén refleje la realidad física del día de hoy.

## 3. Funciones SQL

### `crear_producto(p_nombre text, p_precio numeric, p_costo numeric, p_foto_url text, p_categoria text, p_stock_inicial int, p_usuario_id uuid)`

Reemplaza el `insert` directo a `productos` desde el cliente (ya no es
posible insertar stock directo porque la columna no existe). `SECURITY
DEFINER`.

1. Valida `p_precio > 0`, `p_costo > 0`, `p_stock_inicial >= 0` (0 es
   válido — un producto puede darse de alta antes de que llegue la
   mercancía).
2. Inserta en `productos` (sin columna stock).
3. Si `p_stock_inicial > 0`: inserta/actualiza `stock_almacen` (producto,
   Central) += `p_stock_inicial`, e inserta un `movimientos_almacen` con
   `almacen_origen_id = null`, `almacen_destino_id = Central`,
   `usuario_id = p_usuario_id`.
4. Devuelve el producto creado.

**Editar** un producto existente (nombre, precio, costo, foto, categoría)
sigue siendo un `update` directo desde el cliente — no toca stock.

### `registrar_entrada(p_producto_id uuid, p_cantidad int, p_usuario_id uuid)`

1. Verifica que `p_usuario_id` tenga `rol = 'admin'` y `activo = true` →
   si no, `PERMISO_DENEGADO`.
2. Valida `p_cantidad > 0`.
3. `insert ... on conflict (producto_id, almacen_id) do update set
   cantidad = stock_almacen.cantidad + p_cantidad` sobre (producto,
   Central).
4. Inserta `movimientos_almacen` (`almacen_origen_id = null`,
   `almacen_destino_id = Central`).

### `registrar_traspaso(p_producto_id uuid, p_almacen_origen_id uuid, p_almacen_destino_id uuid, p_cantidad int, p_usuario_id uuid)`

1. Verifica admin activo → `PERMISO_DENEGADO`.
2. Valida `p_cantidad > 0` y `p_almacen_origen_id <> p_almacen_destino_id`
   → `MOVIMIENTO_INVALIDO`.
3. Bloquea (`for update`) la fila de `stock_almacen` de origen. Si no
   existe o `cantidad < p_cantidad` → `STOCK_INSUFICIENTE`.
4. Resta `p_cantidad` del origen, suma (`upsert`) al destino.
5. Inserta `movimientos_almacen`.

### `anular_movimiento(p_movimiento_id uuid, p_usuario_id uuid)`

1. Verifica admin activo → `PERMISO_DENEGADO`.
2. `select ... for update` del movimiento; no encontrado →
   `NO_ENCONTRADO`; ya anulado → `YA_ANULADO`.
3. Bloquea la fila de `stock_almacen` del **destino**. Si
   `cantidad < movimiento.cantidad` → `STOCK_INSUFICIENTE_PARA_ANULAR`
   (el destino ya movió o vendió esas unidades — no se puede revertir).
4. Resta `cantidad` del destino. Si `almacen_origen_id` no es null (era un
   traspaso), suma `cantidad` de vuelta al origen (`upsert`); si es null
   (era una entrada), no hay origen que restaurar — las unidades
   simplemente dejan de existir en el sistema.
5. Marca `anulado = true`, `anulado_por`, `anulado_en`.

### `registrar_venta()` (rework — 3ª vez, ver tickets 05/06/11)

Cambia el origen/destino del stock de `productos.stock` a
`stock_almacen` del almacén del vendedor:

1. Por cada item: `select a.id into v_almacen_id from almacenes a where
   a.usuario_id = p_vendedor_id` (el almacén propio del vendedor).
2. `select cantidad from stock_almacen where producto_id = ... and
   almacen_id = v_almacen_id for update` — si no existe la fila o
   `cantidad < item.cantidad` → `STOCK_INSUFICIENTE` (mismo código que
   hoy, el frontend no necesita cambiar su manejo de error).
3. Resta del `stock_almacen` de ese almacén (ya no toca `productos.stock`,
   que deja de existir).
4. El resto de la función (folio, `venta_items`, `costo_unitario`,
   `venta_pagos`, saldo del cliente) no cambia respecto a ticket 11.

### `anular_venta()` (rework — 2ª vez, ver ticket 11)

El bloque que repone stock cambia de `productos.stock += cantidad` a
`stock_almacen += cantidad` en el almacén del vendedor de esa venta
(`select a.id from almacenes a where a.usuario_id = ventas.vendedor_id`).
El resto de la función (rama de crédito, `saldo_pendiente_venta`) no
cambia respecto a ticket 11.

## 4. Frontend

### Inventario

- `loadProductos()` ahora hace join con `stock_almacen` para mostrar el
  total (`sum(cantidad)` por producto) en la tarjeta — igual que hoy
  visualmente, solo cambia de dónde sale el número.
- Alta de producto: el campo "Stock inicial" se mantiene en el formulario,
  pero ahora llama a `crear_producto()` en vez de un `insert` directo.
- Editar producto: el campo de stock **desaparece** del formulario de
  edición (ya no aplica — no se puede "editar" un total que es la suma de
  varios almacenes). En su lugar, el panel de edición gana una sección de
  solo lectura "Stock por almacén": lista **todos** los almacenes
  existentes (incluidos los que tienen 0 de ese producto), para que quede
  claro qué almacenes existen aunque no traigan nada de ese producto en
  particular.
- Botón "Registrar entrada" — accesible desde el detalle/edición del
  producto (admin-only), abre un mini-formulario (cantidad) →
  `registrar_entrada()`.

### Carrito de venta (`openVentaPanel()` / `renderVentaProductos()` / `addToCarrito()`)

Hoy la consulta de productos disponibles para vender es
`supabase.from('productos').select('id, nombre, precio, stock, costo')` —
esa columna `stock` **deja de existir**. Cambia a un join con
`stock_almacen` filtrado al almacén propio del vendedor logueado:

```js
supabase.from('productos')
  .select('id, nombre, precio, costo, stock_almacen!inner(cantidad)')
  .eq('stock_almacen.almacen_id', session.almacenId)
```

(`session.almacenId` se agrega a la sesión guardada en `localStorage` al
hacer login: justo después de que `login_usuario()` devuelve el usuario,
una consulta aparte a `almacenes where usuario_id = session.id` resuelve su
almacén propio y se guarda junto con el resto de la sesión — no se toca la
firma de `login_usuario()`.) El resultado se
aplana a `producto.stock = row.stock_almacen[0]?.cantidad ?? 0` para que
`renderVentaProductos()`/`addToCarrito()` seguir usando `producto.stock`
tal cual sin más cambios — la lista ahora refleja lo que el vendedor
logueado trae en su propio almacén, no el total del negocio. Un producto
sin fila en `stock_almacen` para ese almacén (nunca le han traspasado nada)
simplemente no aparece en la lista de "productos disponibles" (stock 0).

### Movimientos (nuevo acceso rápido + panel)

- Botón "📦 Movimientos" en Inicio, junto a los ya existentes — visible
  para todos.
- Panel fullscreen con lista de movimientos: fecha, producto,
  "Entrada → Central" o "Traspaso: {origen} → {destino}", cantidad, quién
  lo registró, tag "Anulado" si aplica.
- Solo si `session.rol === 'admin'`:
  - FAB (+) abre bottom sheet con toggle **Entrada / Traspaso** (mismo
    patrón visual que Contado/Crédito en Ventas):
    - Entrada: producto + cantidad (destino Central implícito, no se
      muestra selector).
    - Traspaso: producto + almacén origen + almacén destino + cantidad.
  - Botón "Anular" por movimiento no anulado.

## 5. Mapeo de errores (frontend)

| Código | Mensaje al usuario |
|---|---|
| `PERMISO_DENEGADO` | "Solo un administrador puede registrar/anular movimientos de almacén." |
| `STOCK_INSUFICIENTE` (traspaso) | "Ese almacén no tiene suficiente cantidad para traspasar." |
| `STOCK_INSUFICIENTE` (venta) | "No tienes suficiente stock de este producto en tu almacén." (mismo mensaje que ya existe, sin cambio) |
| `STOCK_INSUFICIENTE_PARA_ANULAR` | "No se puede anular: esas unidades ya se movieron o vendieron desde entonces." |
| `MOVIMIENTO_INVALIDO` | "El almacén de origen y destino no pueden ser el mismo." |
| `YA_ANULADO` | "Este movimiento ya estaba anulado." |

## 6. Casos de prueba

- Alta de producto con stock inicial 10 → aparece un movimiento "Entrada →
  Central" de 10, `stock_almacen` de Central queda en 10.
- Alta de producto con stock inicial 0 → no se genera ningún movimiento
  (nada que registrar).
- Admin traspasa 5 de Central a Angie → `stock_almacen` de Central baja 5,
  el de Angie sube 5, aparece el movimiento en el panel.
- Admin traspasa directo de Angie a Alexa (sin pasar por Central) →
  funciona en un solo movimiento.
- Traspaso de un almacén con menos cantidad de la que se pide → bloqueado
  con `STOCK_INSUFICIENTE`, nada cambia.
- Angie vende un producto que trae en su propio almacén → descuenta de
  `stock_almacen` de Angie, nunca de Central ni de otro vendedor.
- Angie intenta vender más de lo que tiene en su propio almacén (aunque
  Central sí tenga) → bloqueado con `STOCK_INSUFICIENTE`.
- Anular una venta de Angie → repone stock al almacén de Angie
  específicamente (no a Central).
- Admin anula un traspaso reciente (destino todavía tiene la cantidad
  completa) → revierte correctamente, origen recupera la cantidad.
- Admin intenta anular un traspaso cuyo destino ya vendió/traspasó esas
  unidades → bloqueado con `STOCK_INSUFICIENTE_PARA_ANULAR`.
- Admin anula una entrada (no un traspaso) → Central pierde esa cantidad,
  no hay "origen" al que restaurar.
- Un vendedor abre "Movimientos" → ve la lista completa (transparencia),
  pero no ve el botón (+) ni "Anular".
- Se crea un usuario nuevo (ticket 12) → se crea automáticamente su
  almacén personal en la misma operación.
- Se desactiva un usuario con stock en su almacén → su stock se queda
  intacto ahí, nadie lo mueve automáticamente.

## 7. Impacto en tickets ya cerrados

- **Ticket 04 (Inventario):** el campo Stock deja de ser editable
  directamente en edición; gana "Stock inicial" solo en alta y la sección
  de solo lectura por almacén.
- **Ticket 05/06/11 (venta):** `registrar_venta()` cambia su fuente de
  verdad de stock (tercera vez que se toca esta función). El
  comportamiento visible para el usuario no cambia (mismo bloqueo
  `STOCK_INSUFICIENTE`, mismo flujo de carrito) salvo que ahora el stock
  disponible que ve un vendedor es el de **su propio almacén**, no el
  total del negocio.
- **Ticket 08/11 (anulación):** `anular_venta()` cambia dónde repone el
  stock (al almacén del vendedor de esa venta, no a un total global).
- **Ticket 12 (gestión de usuarios):** `crear_usuario()` debe crear
  también la fila en `almacenes` para ese usuario en la misma operación
  (dependencia directa — este ticket bloquea con 12).

## 8. Fuera de alcance (explícito)

- Reportes por almacén (ej. "cuánto vendió cada almacén") — el ticket 11
  ya reporta por vendedor, que en este modelo equivale 1:1 a su almacén;
  no se pide un desglose adicional.
- Transferencias que requieran confirmación del almacén receptor — un
  traspaso registrado por admin es autoritativo e instantáneo, no hay paso
  de "aceptar".
- Ajustes de inventario por merma/pérdida/conteo físico — no se pidió;
  si hace falta, se resolvería hoy anulando y re-registrando movimientos,
  o pidiéndole a Luis que lo ajuste directo en Supabase.
- Múltiples almacenes por usuario, o un almacén compartido entre varios
  usuarios — el modelo es estrictamente 1 usuario ↔ 1 almacén (o Central,
  sin dueño).
- Reconstruir cómo estaba repartido el stock actual entre vendedores antes
  de esta migración — se asigna todo a Central, Luis lo redistribuye a
  mano después con traspasos reales.
