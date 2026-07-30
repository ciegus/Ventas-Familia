# Diseño — Ticket 11 (ampliado): Reportes + Ganancia neta por vendedor

> Ver [TICKETS.md](../../../TICKETS.md) (ticket 11) y [SPEC.md](../../../SPEC.md)
> (sección 11) para el alcance original de Reportes. Este documento amplía ese
> alcance con una pieza nueva no contemplada en el SPEC original: cada vendedor
> se lleva como ganancia neta la diferencia entre el costo del producto y el
> precio al que lo vendió, y el costo del producto debe poder ocultarse en
> pantalla para que un cliente no lo vea por descuido.

## 1. Contexto y decisiones tomadas en esta sesión

1. **Costo por producto:** un solo campo `costo` en `productos` (no historial de
   lotes/compras). Cuando el negocio reabastece un producto a un costo distinto,
   se edita el producto y se actualiza `costo` — pasa a ser "el costo vigente"
   para ventas futuras. No hay costo promedio ponderado ni FIFO de inventario.
2. **Precio de venta ya no es fijo del catálogo:** `productos.precio` se
   mantiene como **"precio sugerido"** (sigue obligatorio, se sigue capturando
   en Inventario), pero al vender, cada vendedor puede **editar el precio de
   cada línea del carrito** libremente antes de confirmar. El campo
   `venta_items.precio_unitario` sigue siendo el snapshot real de venta (ya
   existía), simplemente ahora puede diferir del precio sugerido del producto.
3. **Ocultar costo:** el costo del producto se muestra oculto por default (ej.
   `••••`) con un botón/ícono para revelarlo temporalmente, en dos lugares:
   Inventario (lista/detalle de producto) y Carrito de venta. **Excepción
   explícita:** en Reportes, la sección de detalle artículo por artículo
   **muestra el costo sin ocultar** — es una pantalla de negocio para los 4
   usuarios, no algo que un cliente vería por encima del hombro del vendedor
   durante una venta.
4. **Cuándo se "gana" la ganancia en crédito:** no se cuenta completa al
   momento de la venta — se realiza **proporcionalmente conforme se cobra**
   (enganche al momento de la venta, luego cada abono). Esto es más fiel a
   "ganancia neta" real: si el cliente nunca termina de pagar, esa parte de la
   ganancia nunca se cuenta como obtenida.
5. **A quién se le atribuye la ganancia de un abono:** al **vendedor que hizo
   la venta original**, no a quien cobra el abono — consistente con que "el
   margen de ganancia se va para cada vendedor" (es su ganancia, no de quien
   pasó a cobrar). Como el saldo de un cliente es global (no por venta, ver
   SPEC sección 2/5) y un abono no dice contra qué venta se aplica, esto
   requiere repartir cada abono entre las ventas a crédito abiertas de ese
   cliente, **de la más antigua a la más nueva (FIFO)**.
6. **Ganancia por artículo vendido (detalle) vs. ganancia realizada
   (acumulado por vendedor) son dos cosas distintas:**
   - El **% de utilidad por línea** (`precio_unitario` vs `costo_unitario` de
     esa línea) es descriptivo — no depende de si el cliente ya pagó o no.
   - La **ganancia realizada acumulada por vendedor** sí depende de cobros
     reales (punto 4) — es la que "se lleva" cada quien.
7. **Anular venta a crédito con abonos ya aplicados:** cambia el
   comportamiento de ticket 08. Hoy bloquea con
   `SALDO_INSUFICIENTE_PARA_ANULAR` si anular dejaría el saldo del cliente en
   negativo. Con el tracking nuevo por venta (`saldo_pendiente_venta`), anular
   descuenta del saldo global del cliente **solo lo que le quedaba pendiente a
   esa venta específica** — nunca puede dejar el saldo en negativo, así que
   **el bloqueo deja de ser necesario y se elimina para este caso.** Lo ya
   cobrado (enganche/abonos aplicados) y la ganancia ya atribuida al vendedor
   **no se revierten** — la mercancía no vuelve, pero el dinero ya cobrado
   tampoco se le quita a nadie.
8. **Selector de periodo en Reportes:** navegable por mes (‹ Julio 2026 ›), no
   solo el mes actual.
9. **Costo obligatorio:** no se puede guardar un producto sin costo, igual que
   ya pasa con precio y foto. El único producto ya existente
   ("Playera polo azul", precio $250, stock 41) se migra con
   **`costo = 150.00`** (confirmado por Luis) para no dejar la fila inválida
   al agregar el `NOT NULL`.

## 2. Esquema — cambios en Supabase

```sql
-- productos: costo obligatorio
alter table productos add column costo numeric;
update productos set costo = 150.00 where nombre = 'Playera polo azul';
alter table productos alter column costo set not null;
alter table productos add constraint productos_costo_check check (costo > 0);

-- venta_items: snapshot de costo por línea
alter table venta_items add column costo_unitario numeric not null default 0;
alter table venta_items alter column costo_unitario drop default;
alter table venta_items add constraint venta_items_costo_check check (costo_unitario >= 0);

-- ventas: snapshot de costo total + saldo pendiente propio de la venta (solo crédito)
alter table ventas add column costo_total numeric not null default 0;
alter table ventas alter column costo_total drop default;
alter table ventas add column saldo_pendiente_venta numeric not null default 0;
alter table ventas add constraint ventas_saldo_pendiente_venta_check check (saldo_pendiente_venta >= 0);

-- nueva tabla: cada cobro real (enganche o abono aplicado) con su ganancia ya calculada
create table venta_pagos (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ventas(id),
  abono_id uuid references abonos(id),  -- null = fue el enganche o el pago de contado
  monto numeric not null check (monto > 0),
  utilidad_realizada numeric not null,
  creado_en timestamptz not null default now()
);
create index venta_pagos_venta_id_idx on venta_pagos(venta_id);
create index venta_pagos_abono_id_idx on venta_pagos(abono_id);
```

`venta_items.costo_unitario` y `ventas.costo_total` llevan `default 0` solo
para poder agregar la columna sin romper las 13 filas ya existentes, y se
quita el default inmediatamente — de aquí en adelante siempre los llena
`registrar_venta()`. Las filas viejas quedan en 0 (no hay costo histórico real
que reconstruir); se excluyen implícitamente de los reportes de ganancia por
quedar con utilidad 0, y no afectan nada más.

## 3. Funciones SQL — cambios

### `registrar_venta()` (rework)

Ya existente desde ticket 05/06. Cambios:

1. Por cada item del carrito, lee `productos.costo` además de `productos.precio`
   (el precio ahora lo manda el cliente por línea, ya no se re-lee del
   catálogo — validación server-side: `precio_unitario > 0`, igual que hoy).
2. Inserta `venta_items.costo_unitario` = costo del producto en ese momento.
3. Calcula `costo_total` = suma de `costo_unitario * cantidad`. Lo guarda en
   `ventas.costo_total`.
4. **Contado:** inserta una fila en `venta_pagos`:
   `(venta_id, abono_id=null, monto=total, utilidad_realizada = total - costo_total)`.
5. **Crédito:**
   - Si `enganche > 0`: inserta `venta_pagos`
     `(venta_id, abono_id=null, monto=enganche, utilidad_realizada = enganche - costo_total * (enganche/total))`.
   - `saldo_pendiente_venta := total - enganche`.
   - `cliente.saldo_pendiente += saldo_pendiente_venta` (igual que hoy).

### `registrar_abono()` (rework)

Ya existente desde ticket 07. Después de la validación actual (monto no mayor
al saldo pendiente del cliente), en vez de solo restar del saldo global:

```
restante := monto
for venta in (
  select * from ventas
  where cliente_id = p_cliente_id and tipo = 'credito'
    and anulado = false and saldo_pendiente_venta > 0
  order by creado_en asc
  for update
)
loop
  aplicado := least(restante, venta.saldo_pendiente_venta)
  ratio := (venta.total - venta.costo_total) / venta.total
  utilidad := aplicado * ratio
  insert into venta_pagos(venta_id, abono_id, monto, utilidad_realizada)
    values (venta.id, nuevo_abono_id, aplicado, utilidad)
  update ventas set saldo_pendiente_venta = saldo_pendiente_venta - aplicado
    where id = venta.id
  restante := restante - aplicado
  exit when restante <= 0
end loop
cliente.saldo_pendiente -= monto  -- igual que hoy
```

El invariante `cliente.saldo_pendiente = sum(ventas.saldo_pendiente_venta)`
para ese cliente se mantiene por construcción (solo `registrar_venta` y esta
función tocan ambos lados a la vez).

### `anular_abono()` (rework)

Antes de sumar el monto de vuelta al saldo del cliente (paso ya existente),
revierte la asignación FIFO de ese abono:

```
for vp in (select * from venta_pagos where abono_id = p_abono_id)
loop
  update ventas set saldo_pendiente_venta = saldo_pendiente_venta + vp.monto
    where id = vp.venta_id
  delete from venta_pagos where id = vp.id
end loop
```

### `anular_venta()` (rework — solo rama crédito)

- Elimina el cálculo actual `monto_pendiente := total - enganche` y el
  bloqueo `SALDO_INSUFICIENTE_PARA_ANULAR`.
- En su lugar: `cliente.saldo_pendiente -= venta.saldo_pendiente_venta`
  (siempre ≥ 0 por invariante), luego `venta.saldo_pendiente_venta := 0`.
- Las filas de `venta_pagos` ya generadas por esta venta (enganche y/o abonos
  ya aplicados) **no se tocan** — la ganancia ya realizada y el dinero ya
  cobrado quedan como están.
- Rama de contado: sin cambios (reposición de stock igual que hoy). Los
  reportes de ganancia excluyen ventas anuladas filtrando
  `ventas.anulado = false` al sumar `venta_pagos`.

## 4. Inventario y Carrito de venta — UI

**Inventario:**
- Formulario alta/edición: nuevo campo "Costo" (obligatorio, mismo tipo de
  validación que precio: numérico > 0). El campo "Precio" existente se
  relabelea a "Precio sugerido" pero es el mismo campo, sigue obligatorio.
- Lista y detalle de producto: el costo se muestra oculto (`••••`) con un
  ícono/botón "👁" junto a él que lo revela mientras se mantiene visible esa
  sesión de pantalla (se vuelve a ocultar al salir y reentrar a la vista,
  mismo patrón simple que el resto de la app — sin persistir preferencia).

**Carrito de venta:**
- Cada línea del carrito precarga el precio con el "precio sugerido" del
  producto, en un input editable — el vendedor puede cambiarlo antes de
  confirmar.
- El costo del producto aparece junto a cada línea, oculto por default con el
  mismo botón "👁" de Inventario.
- Sin cambios en la validación de stock ni en el resto del flujo de venta
  (tickets 05/06).

## 5. Reportes (ticket 11) — UI

Pestaña "Reportes" (hoy placeholder) se construye completa:

1. **Selector de periodo:** `‹ Julio 2026 ›` — navega mes a mes, limita el
   rango de todas las secciones de abajo excepto la 3.
2. **Tarjetas de totales del periodo:** Total vendido (contado + crédito,
   ventas no anuladas), Ganancia neta del negocio (suma de
   `venta_pagos.utilidad_realizada` de pagos dentro del periodo, vía join a
   ventas no anuladas).
3. **Saldo pendiente del negocio** (suma de `saldo_pendiente` de todos los
   clientes) y **listado de clientes con saldo**, mayor a menor — corte "a
   hoy", no depende del selector de periodo (es un saldo vivo, no algo que
   pasó "en" un mes).
4. **Tabla por vendedor:** para cada uno de los 4 usuarios, tres columnas con
   base de atribución distinta (a propósito — miden cosas distintas):
   - **Total vendido:** actividad — suma de `ventas.total` donde
     `ventas.vendedor_id = X` (quien capturó la venta), en el periodo.
   - **Total abonado (cobrado):** actividad — suma de `abonos.monto` donde
     `abonos.vendedor_id = X` (quien registró el cobro, sin importar de quién
     era la venta original), en el periodo. Igual que el punto 4 original del
     SPEC/ticket 11, sin cambios.
   - **Ganancia neta realizada:** ganancia — suma de
     `venta_pagos.utilidad_realizada` donde `venta_pagos.venta_id` pertenece a
     una venta con `vendedor_id = X` (el vendedor **dueño de la venta
     original**, sin importar quién cobró cada abono — ver punto 5 de la
     sección 1), filtrando `venta_pagos.creado_en` dentro del periodo y
     `ventas.anulado = false`.
5. **Detalle artículo por artículo:** tabla de `venta_items` de ventas no
   anuladas dentro del periodo — producto, cantidad, costo unitario, precio
   unitario, % utilidad (`(precio-costo)/precio*100`), vendedor, folio, fecha.
   **Sin ocultar costo aquí** (ver punto 3 de la sección 1).
6. Todo en tablas/texto, sin gráficas (SPEC sección 11, sin cambios).

## 6. Impacto en tickets ya cerrados

- **Ticket 05/06 (venta):** el carrito gana precio editable por línea y
  visualización de costo oculto — no cambia la lógica de stock/folio/cliente
  ya construida.
- **Ticket 07 (abonos):** `registrar_abono()` gana la asignación FIFO interna;
  sin cambios visibles para el usuario en el flujo de captura de abono.
- **Ticket 08 (anulaciones):** cambia el comportamiento de anular una venta a
  crédito con abonos ya aplicados (ver punto 7 de la sección 1) — ya no se
  bloquea, se resuelve automáticamente. El caso de prueba
  "anular venta a crédito cuando el cliente ya abonó de más → rechaza con
  SALDO_INSUFICIENTE_PARA_ANULAR" del diseño de ticket 08 queda obsoleto y se
  reemplaza por el nuevo comportamiento.
- **Ticket 04 (inventario):** gana el campo costo obligatorio.

## 7. Casos de prueba

- Alta de producto sin costo → bloqueado, mismo patrón que precio/foto.
- Venta de contado: costo snapshot correcto en `venta_items`/`ventas`, ganancia
  completa registrada en `venta_pagos` al vendedor de la venta.
- Venta a crédito con enganche: ganancia proporcional al enganche se realiza
  de inmediato; el resto queda pendiente en `saldo_pendiente_venta`.
- Cliente con 2 ventas a crédito de distinto vendedor y distinto margen: un
  abono se reparte primero a la venta más antigua (FIFO); si alcanza, sigue
  con la siguiente; la ganancia de cada porción se atribuye al vendedor
  correcto de cada venta.
- Anular un abono: revierte exactamente los `venta_pagos` que había generado,
  regresa `saldo_pendiente_venta` a cada venta afectada.
- Anular venta a crédito con abonos ya aplicados: ya no se bloquea; el saldo
  del cliente baja solo lo que quedaba pendiente de esa venta; la ganancia ya
  realizada por los abonos previos no se revierte.
- Reportes: cambiar de mes recalcula todos los totales; el detalle
  artículo por artículo no oculta costo; Inventario y Carrito sí lo ocultan
  por default y lo revelan con el botón.
- Producto editado para subir/bajar costo: ventas futuras usan el nuevo costo,
  ventas pasadas conservan su `costo_unitario` snapshot sin cambiar.

## 8. Fuera de alcance (explícito)

- Costeo por lote/FIFO de inventario o costo promedio ponderado — se usa
  siempre "el costo vigente" del producto (ver punto 1 de la sección 1).
- Cualquier mecanismo de "pago"/retiro real de la ganancia acumulada a cada
  vendedor — esto es un reporte informativo, no un módulo de nómina/comisiones
  con saldo a favor de cada vendedor.
- Persistir la preferencia de "mostrar costo" entre sesiones — se oculta de
  nuevo cada vez que se reentra a la pantalla.
- Exportar Reportes a Excel/CSV o mostrar gráficas (ya fuera de alcance en
  SPEC sección 13).
