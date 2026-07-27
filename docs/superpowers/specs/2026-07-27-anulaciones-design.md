# Diseño — Ticket 08: Anulaciones

> Ver [TICKETS.md](../../../TICKETS.md) (ticket 08) y [SPEC.md](../../../SPEC.md)
> (sección 6) para el contexto original. Este documento resuelve las
> ambigüedades que quedaban pendientes antes de implementar.

## Contexto y decisiones tomadas en esta sesión

1. **No existía pantalla de "historial de ventas/abonos"** — ningún ticket
   anterior la construyó. Se agrega como parte de este ticket 08 (no se
   pospone al ticket 10, que solo cubre el resumen del día en Inicio).
2. **Acceso**: tercer botón de acción rápida en Inicio ("Historial"), abre
   panel fullscreen — no se agrega una 5ª pestaña (el SPEC sección 10 fija 4
   pestañas fijas).
3. **Alcance de la lista**: todo el historial del negocio, sin límite de
   fecha visible al usuario (con límite técnico de 200 filas como guarda de
   rendimiento).
4. **Confirmación al anular**: simple (confirm/cancelar), sin campo de
   motivo — consistente con que el resto de la app no pide justificaciones
   escritas.
5. **Caso límite descubierto**: anular una venta a crédito después de que el
   cliente ya abonó de más contra el saldo global dejaría `saldo_pendiente`
   negativo (viola el constraint `>= 0` de `clientes`). Decisión: **se
   bloquea la anulación** con mensaje claro en vez de recortar el saldo a
   $0. El admin puede resolverlo manualmente si el saldo del cliente lo
   permite (por ejemplo si el cliente hizo otra compra a crédito después).

Se verificó el esquema real en Supabase (proyecto `ventas-familia`, ref
`wiewxgkiefsjeonirsid`): las columnas `anulado`, `anulado_por`, `anulado_en`
ya existen en `ventas` y `abonos` desde el ticket 01. **No se requiere
migración de esquema**, solo dos funciones SQL nuevas.

## 1. Backend — funciones SQL

Ambas `SECURITY DEFINER`, mismo patrón atómico (todo o nada dentro de la
función) que `registrar_venta`/`registrar_abono`. Errores se comunican como
mensaje de excepción con un código de texto reconocible, igual que
`STOCK_INSUFICIENTE` en `registrar_venta`.

### `anular_venta(p_venta_id uuid, p_usuario_id uuid)`

1. `SELECT ... FOR UPDATE` de la venta (tipo, cliente_id, total, enganche,
   vendedor_id, anulado). No encontrada → error `NO_ENCONTRADO`.
2. Ya `anulado = true` → error `YA_ANULADO`.
3. Verifica permiso: `usuarios.rol` de `p_usuario_id` debe ser `admin`, o
   `vendedor_id` debe ser igual a `p_usuario_id`. Si no → error
   `PERMISO_DENEGADO`.
4. Repone stock: por cada fila de `venta_items` de esta venta,
   `productos.stock += cantidad` (aplica siempre, contado o crédito — ya
   confirmado en SPEC sección 14.2).
5. Si `tipo = 'credito'`: calcula `monto_pendiente := total - enganche`,
   bloquea la fila del cliente (`FOR UPDATE`). Si
   `cliente.saldo_pendiente < monto_pendiente` → error
   `SALDO_INSUFICIENTE_PARA_ANULAR` (revierte toda la función, incluido el
   stock repuesto en el paso 4). Si alcanza,
   `saldo_pendiente -= monto_pendiente`.
6. Marca `anulado = true`, `anulado_por = p_usuario_id`,
   `anulado_en = now()`.

### `anular_abono(p_abono_id uuid, p_usuario_id uuid)`

1. `SELECT ... FOR UPDATE` del abono (cliente_id, monto, vendedor_id,
   anulado). No encontrado → `NO_ENCONTRADO`.
2. Ya anulado → `YA_ANULADO`.
3. Mismo chequeo de permiso que arriba → `PERMISO_DENEGADO`.
4. `cliente.saldo_pendiente += monto` (siempre seguro, nunca puede violar el
   constraint `>= 0` porque solo suma).
5. Marca `anulado = true`, `anulado_por`, `anulado_en`.

## 2. Pantalla nueva: Historial

- Botón "📋 Historial" en `tab-inicio`, junto a "Nueva venta" / "Nuevo
  abono" — abre `historial-panel`, un `fullscreen-overlay` con el mismo
  patrón visual que `venta-panel`/`abono-panel`.
- Chips de filtro (`chip-row`, reutiliza el patrón de
  `inventario-filtros`): **Todos / Ventas / Abonos**.
- Datos: dos queries (`ventas` con join a `clientes`/`usuarios`, `abonos`
  con join a `clientes`/`usuarios`), combinadas y ordenadas por `creado_en`
  descendente en JS (Supabase JS no hace `UNION` nativo). Límite de 200
  filas por query como guarda de rendimiento.
- Cada card:
  - Ícono según tipo (🛒 venta / 💵 abono)
  - Folio, cliente (o "Sin cliente"), vendedor, fecha/hora
  - Monto (total de la venta, o monto del abono)
  - Badge Contado/Crédito si es venta
  - Si `anulado = true`: card atenuada (opacidad reducida), monto con
    `text-decoration: line-through`, leyenda "Anulado por {nombre} ·
    {fecha}", **sin** botón Anular
  - Si no anulado y el usuario tiene permiso (`session.rol === 'admin'` o
    `session.id === vendedor_id`): botón "Anular" (outline, acento rojo)

## 3. Flujo de anular (cliente)

1. Tap en "Anular" → confirmación simple: *"¿Seguro que quieres anular esta
   {venta/abono} de $X (folio REC-XXXX)? No se puede deshacer."* —
   Cancelar/Anular.
2. Verificación de conexión antes de llamar (mismo patrón que el resto de
   la app) — sin internet, bloquea con error claro, no falla en silencio.
3. Llama `supabase.rpc('anular_venta' | 'anular_abono', { p_venta_id |
   p_abono_id, p_usuario_id: session.id })`.
4. Mapeo de errores a mensaje:
   - `PERMISO_DENEGADO` → "No tienes permiso para anular este registro."
   - `YA_ANULADO` → "Este registro ya estaba anulado."
   - `SALDO_INSUFICIENTE_PARA_ANULAR` → "No se puede anular: el cliente ya
     abonó contra este saldo. Contacta al admin."
   - Otro/desconocido → "No se pudo anular. Intenta de nuevo."
5. Éxito → toast "Registro anulado", refresca la lista de historial y
   dispara `loadProductos()`/`loadClientes()` en segundo plano para que
   stock/saldo queden al día en el resto de la app.

## 4. Casos de prueba

- Vendedor anula su propia venta de contado → stock repuesto, card pasa a
  atenuada/tachada, botón desaparece.
- Vendedor sin permiso no ve botón Anular en registros ajenos (y si se
  fuerza la llamada, el RPC rechaza con `PERMISO_DENEGADO`).
- Admin anula venta de cualquier vendedor → funciona.
- Anular venta a crédito con saldo suficiente → saldo del cliente baja
  `(total − enganche)`, stock repuesto.
- Anular venta a crédito cuando el cliente ya abonó de más → RPC rechaza
  con `SALDO_INSUFICIENTE_PARA_ANULAR`, nada cambia (ni stock ni saldo).
- Anular abono → saldo del cliente sube el monto correspondiente.
- Doble tap rápido sobre "Anular" → segundo intento rechazado con
  `YA_ANULADO`, no revierte dos veces.
- Sin conexión al anular → bloquea con error claro.
- Filtros Todos/Ventas/Abonos funcionan correctamente sobre la lista
  combinada.
