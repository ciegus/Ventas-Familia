# Diseño — Ticket 14: Deuda de consigna por vendedor

> Depende de ticket 13 (multi-almacén, ver
> [2026-07-30-multi-almacen-design.md](2026-07-30-multi-almacen-design.md)) — reutiliza
> `almacenes`, `stock_almacen` y `movimientos_almacen` como base. No reemplaza ni toca el
> modelo de `Clientes` (saldo pendiente + abonos) — es una cuenta interna separada, entre
> Papá y cada vendedor, que **no debe confundirse con el crédito a clientes externos**.

## 1. Contexto y problema

Papá le entrega mercancía a un vendedor (Angie, Alexa, Alexis) en consigna. El vendedor la
vende a un cliente externo y le debe a Papá **solo el costo** del producto (no el precio de
venta) — se queda con el margen. Hoy no existe forma de rastrear cuánto le debe cada
vendedor por costo de consigna.

## 2. Decisiones tomadas en esta sesión

1. **La deuda se dispara por la asignación física, no por la venta al cliente final.**
   Cuando se traspasa producto a un vendedor, sube su deuda por el costo de lo traspasado.
   Vender el producto a un cliente externo **no toca esta deuda** — eso ya se registra
   aparte en `ventas`/`clientes`. El vendedor sigue debiendo el costo hasta que pague en
   efectivo o regrese físicamente lo que no vendió.
2. **Un traspaso vendedor→vendedor también mueve la deuda entre ambos** — a quien entrega
   se le resta, a quien recibe se le suma. Así el total de deuda en el sistema nunca se
   descuadra sin importar cuántas veces se mueva el producto entre vendedores.
3. **Costo snapshot por movimiento**, no costo actual del catálogo — mismo criterio que ya
   usa `venta_items.costo_unitario`. Cada traspaso guarda el costo del producto en el
   momento exacto en que ocurre. Si el costo del producto cambia después en Inventario, no
   afecta retroactivamente deudas ya generadas por traspasos viejos.
4. **Solo admin (Papá) registra pagos de consigna** — mismo patrón que entradas/traspasos
   de ticket 13. Un vendedor no se auto-registra como pagado.
5. **Vive dentro de la pantalla "📦 Movimientos"** — no es una pestaña nueva. Se integra
   como un tercer tipo de movimiento junto a Entrada/Traspaso, más un resumen de deuda por
   vendedor arriba de la lista.
6. **Genera folio y recibo**, igual que venta/abono de cliente — el recibo muestra el monto
   pagado y la deuda restante del vendedor después del pago.
7. **Anular revierte automáticamente la deuda** — anular un traspaso resta/suma de vuelta
   según corresponda; anular un pago de consigna vuelve a sumar la deuda. Un traspaso
   bloqueado por `STOCK_INSUFICIENTE_PARA_ANULAR` (ya existe en ticket 13) tampoco toca la
   deuda — nunca queda desincronizada del stock real.
8. **Nombre deliberadamente distinto de "abono"** — se usa "pago de consigna" y la tabla
   `pagos_consigna`, para no mezclar terminología con los abonos de `Clientes` (concepto
   distinto: cliente externo vs. vendedor de la familia).
9. **La deuda solo aplica a usuarios con rol `vendedor`.** El admin también tiene su propio
   almacén (ticket 13, punto 1) y puede traspasarse producto a sí mismo para vender
   directo, pero no tiene sentido que se genere una "deuda" de Papá hacia Papá. Las
   funciones SQL deben verificar el rol del dueño del almacén antes de tocar
   `deuda_consigna` — si el dueño es admin, no se actualiza nada.

## 3. Esquema — cambios en Supabase

```sql
-- Deuda de consigna: cuánto le debe cada vendedor a Papá ahora mismo.
alter table usuarios add column deuda_consigna numeric not null default 0;

-- Costo congelado al momento del movimiento (para poder mover deuda con precisión
-- histórica, igual que venta_items.costo_unitario).
alter table movimientos_almacen add column costo_snapshot numeric;

-- Pagos de consigna: un renglón por cada pago que un vendedor le hace a Papá.
create table pagos_consigna (
  id uuid primary key default gen_random_uuid(),
  folio text not null unique,
  vendedor_id uuid not null references usuarios(id),
  monto numeric not null check (monto > 0),
  deuda_restante numeric not null,
  usuario_id uuid not null references usuarios(id),
  anulado boolean not null default false,
  anulado_por uuid references usuarios(id),
  anulado_en timestamptz,
  creado_en timestamptz not null default now()
);
create index pagos_consigna_vendedor_id_idx on pagos_consigna(vendedor_id);
```

## 4. Funciones SQL

### `registrar_traspaso(...)` — rework (2ª vez, ver ticket 13)

Mismos pasos 1-5 de ticket 13 (permiso admin, validación, bloqueo de stock origen,
movimiento de `stock_almacen`), más:

6. Obtiene `costo` actual del producto (`select costo from productos where id =
   p_producto_id`).
7. Resuelve el dueño (`usuario_id`, `rol`) del almacén origen y del almacén destino via
   `almacenes` → `usuarios`.
8. Si el dueño del almacén **origen** existe y tiene `rol = 'vendedor'`: `deuda_consigna -=
   p_cantidad * costo`.
9. Si el dueño del almacén **destino** existe y tiene `rol = 'vendedor'`: `deuda_consigna +=
   p_cantidad * costo`.
10. Inserta `movimientos_almacen` incluyendo `costo_snapshot = costo`.

(Si origen o destino es Central, o el dueño es admin, ese lado simplemente no tiene efecto
en deuda — la condición del paso 8/9 no se cumple.)

### `anular_movimiento(...)` — rework (2ª vez, ver ticket 13)

Mismos pasos 1-4 de ticket 13 (permiso, bloqueo de fila, `STOCK_INSUFICIENTE_PARA_ANULAR`,
reversión de `stock_almacen`), más, usando `movimiento.costo_snapshot`:

5. Si el dueño del almacén **destino** es un vendedor: `deuda_consigna -= movimiento.cantidad
   * movimiento.costo_snapshot` (revierte el `+` original).
6. Si el movimiento tenía almacén **origen** (era traspaso, no entrada) y su dueño es un
   vendedor: `deuda_consigna += movimiento.cantidad * movimiento.costo_snapshot` (revierte
   el `-` original).
7. Marca `anulado = true`, `anulado_por`, `anulado_en` (igual que hoy).

### `registrar_pago_consigna(p_vendedor_id uuid, p_monto numeric, p_usuario_id uuid)`

1. Verifica que `p_usuario_id` tenga `rol = 'admin'` y `activo = true` → si no,
   `PERMISO_DENEGADO`.
2. Valida `p_monto > 0`.
3. `select deuda_consigna from usuarios where id = p_vendedor_id for update`.
4. Si `p_monto > deuda_consigna` → `MONTO_EXCEDE_DEUDA` (no se permite pagar de más, mismo
   criterio que abono de cliente).
5. `deuda_consigna -= p_monto`.
6. Genera folio con `generate_folio()`.
7. Inserta en `pagos_consigna` (folio, vendedor_id, monto, `deuda_restante` = nueva
   `deuda_consigna`, usuario_id, anulado = false).
8. Devuelve el registro creado (para armar el recibo en el frontend).

### `anular_pago_consigna(p_pago_id uuid, p_usuario_id uuid)`

1. Verifica admin activo → `PERMISO_DENEGADO`.
2. `select ... for update` del pago; no encontrado → `NO_ENCONTRADO`; ya anulado →
   `YA_ANULADO`.
3. `deuda_consigna += pago.monto` del vendedor — sin bloqueo (a diferencia del stock, un
   pago siempre se puede revertir).
4. Marca `anulado = true`, `anulado_por`, `anulado_en`.

## 5. Frontend

### Movimientos

- Resumen nuevo arriba de la lista: **"Deuda por vendedor"** — cada usuario con
  `rol = 'vendedor'` y su `deuda_consigna` actual. Visible para todos (consistente con
  "todos ven todo", SPEC sección 1).
- El FAB (+) de admin gana una tercera opción junto a Entrada/Traspaso: **"Pago de
  consigna"** — selecciona vendedor + monto, llama a `registrar_pago_consigna()`, muestra
  el recibo generado.
- La lista de movimientos existente incorpora también los pagos de consigna, mezclados
  cronológicamente con entradas/traspasos, con su propio texto/ícono distinto ("Pago de
  consigna: {vendedor} — ${monto}").
- Botón "Anular" en cada pago de consigna no anulado (admin-only), igual que ya existe para
  traspasos/entradas.

### Reportes

- Nuevo renglón **"Deuda total de consigna pendiente"** (suma de `deuda_consigna` de todos
  los vendedores) junto al de saldo total de clientes que ya existe.
- Listado de vendedores con deuda de consigna, ordenado de mayor a menor — mismo patrón que
  el listado de clientes con saldo pendiente (SPEC sección 11).

### Recibo de pago de consigna

Reutiliza el componente de recibo existente (folio, fecha/hora, quién lo registró, mismas 3
formas de entrega: pantalla, PDF, WhatsApp). Contenido: vendedor, monto pagado, deuda
restante después del pago.

## 6. Mapeo de errores (frontend)

| Código | Mensaje al usuario |
|---|---|
| `PERMISO_DENEGADO` | "Solo un administrador puede registrar/anular pagos de consigna." |
| `MONTO_EXCEDE_DEUDA` | "Ese pago es mayor a la deuda de consigna actual del vendedor." |
| `NO_ENCONTRADO` | "No se encontró ese pago." |
| `YA_ANULADO` | "Ese pago ya estaba anulado." |

(Los códigos de `registrar_traspaso()`/`anular_movimiento()` ya existentes —
`STOCK_INSUFICIENTE`, `STOCK_INSUFICIENTE_PARA_ANULAR`, `MOVIMIENTO_INVALIDO`,
`YA_ANULADO`— no cambian.)

## 7. Casos de prueba

- Traspaso Central→Angie de 5 unidades a $50 de costo → `deuda_consigna` de Angie sube
  $250; el movimiento queda con `costo_snapshot = 50`.
- Angie devuelve 2 unidades a Central (traspaso Angie→Central) → resta `2 × costo actual`
  de la deuda de Angie — usa el costo del producto **en ese momento**, que puede ya no ser
  $50 si cambió en Inventario mientras tanto.
- Angie le pasa 3 unidades a Alexa → a Angie se le resta, a Alexa se le suma, ambos con el
  `costo_snapshot` de ese traspaso puntual — la suma total de deuda en el sistema no
  cambia.
- Papá se traspasa producto a sí mismo (Central→almacén de Papá) para vender directo → no
  genera ninguna deuda (el dueño del almacén destino es admin, no vendedor).
- Papá registra un pago de consigna de Angie mayor a su deuda actual → rechazado con
  `MONTO_EXCEDE_DEUDA`.
- Papá registra un pago de consigna válido → `deuda_consigna` de Angie baja, se genera
  folio y recibo con la deuda restante.
- Se anula un traspaso Central→vendedor viejo, pero el vendedor ya vendió o retraspasó esas
  unidades (stock destino insuficiente) → bloqueado con `STOCK_INSUFICIENTE_PARA_ANULAR`,
  la deuda tampoco se toca (queda consistente con que el stock no se pudo revertir).
- Se anula un traspaso reciente sin ese problema → revierte stock y deuda correctamente en
  ambos lados (origen y destino, si ambos son vendedores).
- Se anula un pago de consigna → la deuda del vendedor vuelve a subir ese monto, sin
  bloqueo.
- Vendedor vende un producto de su almacén a un cliente final → `deuda_consigna` no se
  toca; sigue debiendo el costo hasta pagar o devolver.

## 8. Fuera de alcance (explícito)

- Plazos, fechas límite o recargos sobre la deuda de consigna — igual que el crédito a
  clientes (SPEC 4.2), la deuda no crece con el tiempo ni tiene vencimiento.
- Que el propio vendedor registre sus pagos — solo admin, ver decisión 4.
- Notificaciones o recordatorios de deuda pendiente.
- Tocar la deuda de consigna al desactivar un usuario (ticket 12) — mismo criterio que
  stock en ticket 13: se queda igual, Papá la ajusta manualmente si hace falta antes o
  después de desactivar.
- Deuda de consigna para el rol admin — solo aplica a usuarios con `rol = 'vendedor'` (ver
  decisión 9).
