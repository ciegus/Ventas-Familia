# Deuda de consigna por vendedor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rastrear cuánto le debe cada vendedor a Papá por costo de mercancía en consigna —
la deuda sube al traspasarle producto, baja al pagar o devolver físicamente, con recibo y
folio, todo dentro de la pantalla "Movimientos" ya existente.

**Architecture:** Reutiliza el esquema de multi-almacén del ticket 13 (`almacenes`,
`stock_almacen`, `movimientos_almacen`). Se añade un contador `usuarios.deuda_consigna`
mantenido transaccionalmente por las funciones SQL existentes `registrar_traspaso()` /
`anular_movimiento()` (reworked) y dos funciones nuevas `registrar_pago_consigna()` /
`anular_pago_consigna()` sobre una tabla nueva `pagos_consigna`. El frontend extiende la
pantalla "📦 Movimientos" (`index.html` + `app.js`) sin crear pestañas nuevas.

**Tech Stack:** Supabase Postgres (funciones SQL `plpgsql`, `SECURITY DEFINER`), HTML/CSS/JS
planos sin build step, `@supabase/supabase-js` vía `esm.sh`, service worker manual para caché.

## Global Constraints

- Proyecto Supabase: `ventas-familia`, ref `wiewxgkiefsjeonirsid` — todos los cambios de
  esquema y funciones se aplican con las herramientas MCP de Supabase (`apply_migration`
  para DDL, `execute_sql` para verificación/queries), nunca con archivos `.sql` en el repo
  (no hay carpeta de migraciones versionada en este proyecto).
- Sin build step — no se introduce ningún bundler, transpilador ni framework nuevo.
- Convención de caché: cualquier cambio a `app.js`, `index.html` o `styles.css` requiere
  subir `const CACHE = 'vf-vX'` en `sw.js` al siguiente número antes del último commit.
- Solo admin (`rol = 'admin'`, `activo = true`) puede registrar o anular traspasos, entradas
  y pagos de consigna — mismo patrón de verificación `PERMISO_DENEGADO` ya usado en
  `registrar_entrada()`/`registrar_traspaso()`/`anular_movimiento()`.
- La deuda de consigna (`usuarios.deuda_consigna`) **solo aplica a usuarios con
  `rol = 'vendedor'`** — nunca se actualiza si el dueño del almacén origen/destino es admin.
- Costo snapshot: cada movimiento de almacén guarda el costo del producto en el momento
  exacto del movimiento (`movimientos_almacen.costo_snapshot`) — nunca se recalcula con el
  costo actual del catálogo después de creado.
- **`usuarios.deuda_consigna` no lleva `CHECK >= 0`.** A diferencia de
  `clientes.saldo_pendiente` (protegido por la validación `MONTO_MAYOR_A_SALDO` en
  `registrar_abono()`), la deuda de consigna puede moverse por traspasos
  vendedor→vendedor cuyo `costo_snapshot` no coincide con el costo original de cuando ese
  vendedor recibió la mercancía (si el costo del producto cambió en Inventario mientras
  tanto). Eso puede dejar residuos pequeños positivos o negativos tras varias
  retransferencias del mismo lote — es un comportamiento esperado y documentado, no un bug;
  un `CHECK` estricto aquí causaría que un traspaso legítimo falle con un error de
  constraint. `registrar_pago_consigna()` sigue bloqueando pagos mayores a la deuda actual
  vía `MONTO_EXCEDE_DEUDA` en código de aplicación, no vía constraint de columna.
- Nomenclatura: se usa "pago de consigna" / `pagos_consigna` en vez de "abono", para no
  confundirse con los abonos de `Clientes` (concepto distinto, ver
  [SPEC.md](../../SPEC.md) sección 5).

---

### Task 1: Esquema — columnas nuevas y tabla `pagos_consigna`

**Files:**
- Ninguno en el repo (cambio de esquema vía MCP de Supabase, ver Global Constraints).

**Interfaces:**
- Produce: columna `usuarios.deuda_consigna numeric not null default 0`; columna
  `movimientos_almacen.costo_snapshot numeric`; tabla `pagos_consigna(id, folio, vendedor_id,
  monto, deuda_restante, usuario_id, anulado, anulado_por, anulado_en, creado_en)`.

- [ ] **Step 1: Aplicar la migración**

Usa la herramienta MCP `apply_migration` (proyecto `wiewxgkiefsjeonirsid`) con este SQL:

```sql
alter table usuarios add column deuda_consigna numeric not null default 0;

alter table movimientos_almacen add column costo_snapshot numeric;

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

- [ ] **Step 2: Verificar el esquema**

Ejecuta con `execute_sql`:

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'usuarios' and column_name = 'deuda_consigna';

select column_name, data_type
from information_schema.columns
where table_name = 'movimientos_almacen' and column_name = 'costo_snapshot';

select table_name from information_schema.tables where table_name = 'pagos_consigna';
```

Esperado: la primera consulta devuelve `deuda_consigna | numeric | 0`; la segunda devuelve
`costo_snapshot | numeric`; la tercera devuelve la fila `pagos_consigna`.

- [ ] **Step 3: Confirmar que los usuarios existentes arrancan en 0**

```sql
select nombre, rol, deuda_consigna from usuarios order by nombre;
```

Esperado: todas las filas muestran `deuda_consigna = 0` (nadie tenía deuda antes de esta
migración — es correcto, no hay forma de reconstruir historial retroactivo).

---

### Task 2: Rework `registrar_traspaso()` + `registrar_entrada()` — costo snapshot y deuda

**Files:**
- Ninguno en el repo (función SQL vía MCP).

**Interfaces:**
- Consume: `usuarios.deuda_consigna`, `usuarios.rol`, `almacenes.usuario_id`,
  `productos.costo`, `movimientos_almacen.costo_snapshot` (de Task 1).
- Produce: `registrar_traspaso(p_producto_id uuid, p_almacen_origen_id uuid,
  p_almacen_destino_id uuid, p_cantidad integer, p_usuario_id uuid) returns void` —
  misma firma que ya usa `app.js:2122`, sin cambios de contrato para el frontend.

- [ ] **Step 1: Reemplazar `registrar_traspaso()`**

Aplica con `apply_migration`:

```sql
CREATE OR REPLACE FUNCTION public.registrar_traspaso(p_producto_id uuid, p_almacen_origen_id uuid, p_almacen_destino_id uuid, p_cantidad integer, p_usuario_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rol text;
  v_activo boolean;
  v_cantidad_origen int;
  v_costo numeric;
  v_origen_usuario uuid;
  v_origen_rol text;
  v_destino_usuario uuid;
  v_destino_rol text;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_usuario_id;
  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  if p_cantidad is null or p_cantidad <= 0 or p_almacen_origen_id = p_almacen_destino_id then
    raise exception 'MOVIMIENTO_INVALIDO';
  end if;

  select cantidad into v_cantidad_origen
  from stock_almacen
  where producto_id = p_producto_id and almacen_id = p_almacen_origen_id
  for update;

  if v_cantidad_origen is null or v_cantidad_origen < p_cantidad then
    raise exception 'STOCK_INSUFICIENTE';
  end if;

  update stock_almacen set cantidad = cantidad - p_cantidad
  where producto_id = p_producto_id and almacen_id = p_almacen_origen_id;

  insert into stock_almacen (producto_id, almacen_id, cantidad)
  values (p_producto_id, p_almacen_destino_id, p_cantidad)
  on conflict (producto_id, almacen_id) do update
    set cantidad = stock_almacen.cantidad + excluded.cantidad;

  select costo into v_costo from productos where id = p_producto_id;

  select a.usuario_id, u.rol into v_origen_usuario, v_origen_rol
  from almacenes a left join usuarios u on u.id = a.usuario_id
  where a.id = p_almacen_origen_id;

  select a.usuario_id, u.rol into v_destino_usuario, v_destino_rol
  from almacenes a left join usuarios u on u.id = a.usuario_id
  where a.id = p_almacen_destino_id;

  if v_origen_rol = 'vendedor' then
    update usuarios set deuda_consigna = deuda_consigna - (p_cantidad * v_costo)
    where id = v_origen_usuario;
  end if;

  if v_destino_rol = 'vendedor' then
    update usuarios set deuda_consigna = deuda_consigna + (p_cantidad * v_costo)
    where id = v_destino_usuario;
  end if;

  insert into movimientos_almacen
    (producto_id, almacen_origen_id, almacen_destino_id, cantidad, usuario_id, costo_snapshot)
  values (p_producto_id, p_almacen_origen_id, p_almacen_destino_id, p_cantidad, p_usuario_id, v_costo);
end;
$function$
```

- [ ] **Step 2: Reemplazar `registrar_entrada()` para que también guarde `costo_snapshot`**

```sql
CREATE OR REPLACE FUNCTION public.registrar_entrada(p_producto_id uuid, p_cantidad integer, p_usuario_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rol text;
  v_activo boolean;
  v_central_id uuid;
  v_costo numeric;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_usuario_id;
  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'MOVIMIENTO_INVALIDO';
  end if;

  select id into v_central_id from almacenes where usuario_id is null;
  select costo into v_costo from productos where id = p_producto_id;

  insert into stock_almacen (producto_id, almacen_id, cantidad)
  values (p_producto_id, v_central_id, p_cantidad)
  on conflict (producto_id, almacen_id) do update
    set cantidad = stock_almacen.cantidad + excluded.cantidad;

  insert into movimientos_almacen
    (producto_id, almacen_origen_id, almacen_destino_id, cantidad, usuario_id, costo_snapshot)
  values (p_producto_id, null, v_central_id, p_cantidad, p_usuario_id, v_costo);
end;
$function$
```

(Central no tiene `usuario_id`, así que una entrada nunca mueve `deuda_consigna` — el
`costo_snapshot` aquí solo es para que el historial quede completo, sin efecto en deuda.)

- [ ] **Step 3: Verificar con datos reales**

Ejecuta con `execute_sql` (ajusta nombres si difieren de tu semilla actual):

```sql
-- Antes: apunta un producto y un vendedor real
select p.id as producto_id, p.costo, u.id as vendedor_id, u.deuda_consigna
from productos p, usuarios u
where u.rol = 'vendedor' and u.nombre = 'Angie'
limit 1;
```

Anota `producto_id`, `costo` y `deuda_consigna` actual de Angie. Luego, obtén el almacén
Central y el almacén de Angie:

```sql
select a.id, a.nombre, a.usuario_id from almacenes a
where a.usuario_id is null or a.usuario_id = (select id from usuarios where nombre = 'Angie');
```

Registra una entrada de 5 unidades a Central y luego un traspaso de esas 5 unidades de
Central a Angie:

```sql
select registrar_entrada('<producto_id>', 5, (select id from usuarios where rol='admin' and activo limit 1));

select registrar_traspaso(
  '<producto_id>',
  (select id from almacenes where usuario_id is null),
  (select id from almacenes where usuario_id = (select id from usuarios where nombre = 'Angie')),
  5,
  (select id from usuarios where rol='admin' and activo limit 1)
);

select nombre, deuda_consigna from usuarios where nombre = 'Angie';
select costo_snapshot from movimientos_almacen order by creado_en desc limit 1;
```

Esperado: `deuda_consigna` de Angie subió exactamente `5 * costo` respecto al valor anotado
antes; el último `movimientos_almacen.costo_snapshot` coincide con `costo` del producto.

- [ ] **Step 4: Verificar que un traspaso al propio almacén del admin no genera deuda**

```sql
select registrar_traspaso(
  '<producto_id>',
  (select id from almacenes where usuario_id = (select id from usuarios where nombre = 'Angie')),
  (select id from almacenes where usuario_id = (select id from usuarios where rol='admin' and activo limit 1)),
  2,
  (select id from usuarios where rol='admin' and activo limit 1)
);

select nombre, deuda_consigna from usuarios where rol = 'admin';
```

Esperado: la deuda de Angie bajó `2 * costo`; ningún usuario con `rol = 'admin'` tiene
`deuda_consigna` distinta de 0 (la columna nunca se toca para admins).

- [ ] **Step 5: Verificar traspaso vendedor→vendedor (mueve deuda entre ambos)**

Repite una entrada+traspaso Central→Angie de 4 unidades más (para tener saldo del que
traspasar) y anota la deuda de Angie y de Alexa antes de este paso:

```sql
select nombre, deuda_consigna from usuarios where nombre in ('Angie', 'Alexa');

select registrar_traspaso(
  '<producto_id>',
  (select id from almacenes where usuario_id = (select id from usuarios where nombre = 'Angie')),
  (select id from almacenes where usuario_id = (select id from usuarios where nombre = 'Alexa')),
  4,
  (select id from usuarios where rol='admin' and activo limit 1)
);

select nombre, deuda_consigna from usuarios where nombre in ('Angie', 'Alexa');
```

Esperado: la deuda de Angie bajó `4 * costo` y la de Alexa subió exactamente lo mismo — la
suma de ambas antes y después del traspaso no cambia.

---

### Task 3: Rework `anular_movimiento()` — revertir deuda al anular

**Files:**
- Ninguno en el repo (función SQL vía MCP).

**Interfaces:**
- Consume: `movimientos_almacen.costo_snapshot` (Task 2), `almacenes.usuario_id`,
  `usuarios.rol`/`deuda_consigna`.
- Produce: `anular_movimiento(p_movimiento_id uuid, p_usuario_id uuid) returns void` — misma
  firma que ya usa `app.js:1992`.

- [ ] **Step 1: Reemplazar `anular_movimiento()`**

```sql
CREATE OR REPLACE FUNCTION public.anular_movimiento(p_movimiento_id uuid, p_usuario_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rol text;
  v_activo boolean;
  v_mov record;
  v_cantidad_destino int;
  v_destino_usuario uuid;
  v_destino_rol text;
  v_origen_usuario uuid;
  v_origen_rol text;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_usuario_id;
  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  select * into v_mov from movimientos_almacen where id = p_movimiento_id for update;
  if not found then
    raise exception 'NO_ENCONTRADO';
  end if;
  if v_mov.anulado then
    raise exception 'YA_ANULADO';
  end if;

  select cantidad into v_cantidad_destino
  from stock_almacen
  where producto_id = v_mov.producto_id and almacen_id = v_mov.almacen_destino_id
  for update;

  if v_cantidad_destino is null or v_cantidad_destino < v_mov.cantidad then
    raise exception 'STOCK_INSUFICIENTE_PARA_ANULAR';
  end if;

  update stock_almacen set cantidad = cantidad - v_mov.cantidad
  where producto_id = v_mov.producto_id and almacen_id = v_mov.almacen_destino_id;

  if v_mov.almacen_origen_id is not null then
    insert into stock_almacen (producto_id, almacen_id, cantidad)
    values (v_mov.producto_id, v_mov.almacen_origen_id, v_mov.cantidad)
    on conflict (producto_id, almacen_id) do update
      set cantidad = stock_almacen.cantidad + excluded.cantidad;
  end if;

  select a.usuario_id, u.rol into v_destino_usuario, v_destino_rol
  from almacenes a left join usuarios u on u.id = a.usuario_id
  where a.id = v_mov.almacen_destino_id;

  if v_destino_rol = 'vendedor' and v_mov.costo_snapshot is not null then
    update usuarios set deuda_consigna = deuda_consigna - (v_mov.cantidad * v_mov.costo_snapshot)
    where id = v_destino_usuario;
  end if;

  if v_mov.almacen_origen_id is not null then
    select a.usuario_id, u.rol into v_origen_usuario, v_origen_rol
    from almacenes a left join usuarios u on u.id = a.usuario_id
    where a.id = v_mov.almacen_origen_id;

    if v_origen_rol = 'vendedor' and v_mov.costo_snapshot is not null then
      update usuarios set deuda_consigna = deuda_consigna + (v_mov.cantidad * v_mov.costo_snapshot)
      where id = v_origen_usuario;
    end if;
  end if;

  update movimientos_almacen
  set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
  where id = p_movimiento_id;
end;
$function$
```

- [ ] **Step 2: Verificar reversión completa**

Usando el traspaso Central→Angie de 5 unidades del Task 2 (si ya se anuló el de "Step 4" de
retraspaso a Papá, usa uno nuevo: repite un `registrar_traspaso` Central→Angie de 3
unidades primero). Anota `deuda_consigna` de Angie antes de anular, ubica el
`movimientos_almacen.id` de ese traspaso:

```sql
select id, cantidad, costo_snapshot from movimientos_almacen
where almacen_destino_id = (select id from almacenes where usuario_id = (select id from usuarios where nombre='Angie'))
order by creado_en desc limit 1;

select anular_movimiento('<movimiento_id>', (select id from usuarios where rol='admin' and activo limit 1));

select nombre, deuda_consigna from usuarios where nombre = 'Angie';
```

Esperado: `deuda_consigna` de Angie bajó exactamente `cantidad * costo_snapshot` de ese
movimiento.

- [ ] **Step 3: Verificar que el bloqueo por stock insuficiente sigue funcionando y no toca deuda**

Vende (o traspasa a otro almacén) todo el stock que Angie recibió de un movimiento
concreto, y luego intenta anular ese movimiento original:

```sql
select anular_movimiento('<movimiento_id_ya_sin_stock_suficiente>', (select id from usuarios where rol='admin' and activo limit 1));
```

Esperado: error `STOCK_INSUFICIENTE_PARA_ANULAR`; `select deuda_consigna from usuarios
where nombre = 'Angie';` no cambió respecto a antes del intento.

---

### Task 4: Funciones nuevas — `registrar_pago_consigna()` y `anular_pago_consigna()`

**Files:**
- Ninguno en el repo (funciones SQL vía MCP).

**Interfaces:**
- Consume: tabla `pagos_consigna` (Task 1), `generate_folio()` existente.
- Produce: `registrar_pago_consigna(p_vendedor_id uuid, p_monto numeric, p_usuario_id uuid)
  returns table(folio text, deuda_restante numeric)`; `anular_pago_consigna(p_pago_id uuid,
  p_usuario_id uuid) returns void`. Estas dos firmas son las que el frontend (Task 6/8)
  llamará vía `supabase.rpc(...)`.

- [ ] **Step 1: Extender `generate_folio()` para incluir `pagos_consigna`**

```sql
CREATE OR REPLACE FUNCTION public.generate_folio()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_folio text;
  v_existe boolean;
begin
  loop
    v_folio := 'REC-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    select exists(
      select 1 from ventas where folio = v_folio
      union all
      select 1 from abonos where folio = v_folio
      union all
      select 1 from pagos_consigna where folio = v_folio
    ) into v_existe;
    exit when not v_existe;
  end loop;
  return v_folio;
end;
$function$
```

- [ ] **Step 2: Crear `registrar_pago_consigna()`**

```sql
CREATE OR REPLACE FUNCTION public.registrar_pago_consigna(p_vendedor_id uuid, p_monto numeric, p_usuario_id uuid)
 RETURNS TABLE(folio text, deuda_restante numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rol text;
  v_activo boolean;
  v_deuda numeric;
  v_folio text;
  v_restante numeric;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_usuario_id;
  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  if p_monto is null or p_monto <= 0 then
    raise exception 'MONTO_INVALIDO';
  end if;

  select deuda_consigna into v_deuda from usuarios where id = p_vendedor_id for update;
  if not found then
    raise exception 'NO_ENCONTRADO';
  end if;

  if p_monto > v_deuda then
    raise exception 'MONTO_EXCEDE_DEUDA';
  end if;

  v_folio := generate_folio();
  v_restante := v_deuda - p_monto;

  update usuarios set deuda_consigna = v_restante where id = p_vendedor_id;

  insert into pagos_consigna (folio, vendedor_id, monto, deuda_restante, usuario_id)
  values (v_folio, p_vendedor_id, p_monto, v_restante, p_usuario_id);

  return query select v_folio, v_restante;
end;
$function$
```

- [ ] **Step 3: Crear `anular_pago_consigna()`**

```sql
CREATE OR REPLACE FUNCTION public.anular_pago_consigna(p_pago_id uuid, p_usuario_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rol text;
  v_activo boolean;
  v_pago record;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_usuario_id;
  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  select * into v_pago from pagos_consigna where id = p_pago_id for update;
  if not found then
    raise exception 'NO_ENCONTRADO';
  end if;
  if v_pago.anulado then
    raise exception 'YA_ANULADO';
  end if;

  update usuarios set deuda_consigna = deuda_consigna + v_pago.monto where id = v_pago.vendedor_id;

  update pagos_consigna
  set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
  where id = p_pago_id;
end;
$function$
```

- [ ] **Step 4: Verificar pago válido, pago excedido y anulación**

```sql
select nombre, deuda_consigna from usuarios where nombre = 'Angie'; -- anota v0

select * from registrar_pago_consigna(
  (select id from usuarios where nombre = 'Angie'),
  10,
  (select id from usuarios where rol='admin' and activo limit 1)
);
-- Esperado: folio REC-XXXXXXXX, deuda_restante = v0 - 10

select * from registrar_pago_consigna(
  (select id from usuarios where nombre = 'Angie'),
  999999,
  (select id from usuarios where rol='admin' and activo limit 1)
);
-- Esperado: error MONTO_EXCEDE_DEUDA

select id from pagos_consigna where vendedor_id = (select id from usuarios where nombre='Angie') order by creado_en desc limit 1;
select anular_pago_consigna('<pago_id>', (select id from usuarios where rol='admin' and activo limit 1));
select nombre, deuda_consigna from usuarios where nombre = 'Angie';
-- Esperado: deuda_consigna vuelve a v0

select anular_pago_consigna('<pago_id>', (select id from usuarios where rol='admin' and activo limit 1));
-- Esperado: error YA_ANULADO
```

---

### Task 5: HTML — sheet de pago de consigna, resumen de deuda, sección en Reportes

**Files:**
- Modify: `index.html:260-292` (`#movimiento-sheet`)
- Modify: `index.html:485-501` (`#movimientos-panel`)
- Modify: `index.html:134-140` (Reportes, después de "Saldo pendiente del negocio")

**Interfaces:**
- Produce: ids nuevos que consume Task 6/7/8/9 —
  `#movimiento-vendedor-row`, `#movimiento-vendedor`, `#movimiento-monto-row`,
  `#movimiento-monto`, `#movimiento-paso-armar`, `#movimiento-paso-recibo`,
  `#movimiento-recibo-contenido`, `#movimiento-recibo-pdf`, `#movimiento-recibo-whatsapp`,
  `#movimiento-recibo-cerrar`, `#consigna-deuda-list`, `#consigna-deuda-empty`,
  `#rep-consigna-total`, `#rep-consigna-list`, `#rep-consigna-empty`.

- [ ] **Step 1: Reescribir `#movimiento-sheet` con el tercer tipo y el paso de recibo**

Reemplaza el bloque completo `index.html:260-292` por:

```html
  <!-- ============ Formulario movimiento (bottom sheet) ============ -->
  <div id="movimiento-sheet" class="sheet-overlay">
    <div class="sheet">
      <h3>Nuevo movimiento</h3>

      <div id="movimiento-paso-armar">
        <div class="field">
          <label>Tipo</label>
          <div class="toggle-group" id="movimiento-tipo-toggle">
            <button type="button" class="toggle-btn active" data-tipo="entrada">Entrada</button>
            <button type="button" class="toggle-btn" data-tipo="traspaso">Traspaso</button>
            <button type="button" class="toggle-btn" data-tipo="pago_consigna">Pago consigna</button>
          </div>
        </div>
        <div class="field" id="movimiento-producto-row">
          <label for="movimiento-producto">Producto</label>
          <select id="movimiento-producto"></select>
        </div>
        <div class="field" id="movimiento-origen-row" style="display:none;">
          <label for="movimiento-origen">Almacén origen</label>
          <select id="movimiento-origen"></select>
        </div>
        <div class="field" id="movimiento-destino-row" style="display:none;">
          <label for="movimiento-destino">Almacén destino</label>
          <select id="movimiento-destino"></select>
        </div>
        <div class="field" id="movimiento-cantidad-row">
          <label for="movimiento-cantidad">Cantidad</label>
          <input id="movimiento-cantidad" type="number" step="1" min="1" placeholder="0" />
        </div>
        <div class="field" id="movimiento-vendedor-row" style="display:none;">
          <label for="movimiento-vendedor">Vendedor</label>
          <select id="movimiento-vendedor"></select>
        </div>
        <div class="field" id="movimiento-monto-row" style="display:none;">
          <label for="movimiento-monto">Monto pagado (MXN)</label>
          <input id="movimiento-monto" type="number" step="0.01" min="0" placeholder="0.00" />
        </div>
        <p id="movimiento-form-error" class="error-msg"></p>
        <div class="sheet-actions">
          <button id="movimiento-cancelar" type="button" class="btn btn-outline">Cancelar</button>
          <button id="movimiento-guardar" type="button" class="btn btn-primary">Guardar</button>
        </div>
      </div>

      <div id="movimiento-paso-recibo" style="display:none;">
        <div class="card" id="movimiento-recibo-contenido"></div>
        <button id="movimiento-recibo-pdf" type="button" class="btn btn-outline">Descargar PDF</button>
        <button id="movimiento-recibo-whatsapp" type="button" class="btn btn-outline" style="display:none;">Compartir WhatsApp</button>
        <button id="movimiento-recibo-cerrar" type="button" class="btn btn-primary">Listo</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Agregar el resumen "Deuda de consigna" en el panel de Movimientos**

En `index.html:493-497`, dentro de `.fs-content` de `#movimientos-panel`, antes de
`#movimientos-list`:

```html
    <div class="fs-content">
      <h3 class="fs-subtitle">Deuda de consigna por vendedor</h3>
      <div id="consigna-deuda-list" class="list"></div>
      <p id="consigna-deuda-empty" class="tab-placeholder" style="display:none;">
        No hay vendedores registrados.
      </p>

      <h3 class="fs-subtitle">Historial de movimientos</h3>
      <div id="movimientos-list" class="list"></div>
      <p id="movimientos-empty" class="tab-placeholder" style="display:none;">
        Aún no hay movimientos de almacén registrados.
      </p>
    </div>
```

- [ ] **Step 3: Agregar sección de deuda de consigna en Reportes**

En `index.html`, justo después del bloque que cierra en la línea 139
(`</p>` de `#rep-clientes-saldo-empty`) y antes de `<h3 class="fs-subtitle">Por
vendedor...`, inserta:

```html
        <h3 class="fs-subtitle">Deuda de consigna pendiente (a hoy)</h3>
        <div class="reportes-saldo-total" id="rep-consigna-total">$0.00</div>
        <div id="rep-consigna-list" class="list"></div>
        <p id="rep-consigna-empty" class="tab-placeholder" style="display:none;">
          Ningún vendedor tiene deuda de consigna pendiente.
        </p>
```

- [ ] **Step 4: Verificar que el HTML no rompe la carga**

No hay test runner en este proyecto — abre `index.html` en el navegador (ver Task 10 para
el checklist completo) y confirma en la consola que no hay errores de parseo. Por ahora
basta con: `node --check` no aplica a HTML; simplemente confirma visualmente que los tags
abren/cierran igual en número usando el editor (cada `<div id="movimiento-...">` nuevo tiene
su cierre `</div>` correspondiente dentro del mismo bloque reemplazado).

---

### Task 6: JS — flujo de "Pago de consigna" (abrir, guardar, recibo)

**Files:**
- Modify: `app.js:1905-1907` (declaración de caches junto a `movimientosCache`)
- Modify: `app.js:2031-2151` (`openMovimientoForm`, `guardarMovimiento`)
- Modify: `app.js:2153-2171` (`initMovimientos`)

**Interfaces:**
- Consume: `supabase.rpc('registrar_pago_consigna', {...})` (Task 4);
  `capturarRecibo`/`descargarReciboPDF`/`compartirReciboWhatsApp` (ya existen en
  `app.js:704-778`, firma `(contenedorEl, folio, btn)`); `money`, `fechaFmt`, `escapeHtml`,
  `soportaCompartirArchivos` (ya existen).
- Produce: `mostrarReciboPagoConsigna(info)` — usada también por Task 8 indirectamente vía
  refresco de `loadDeudaConsigna()`.

- [ ] **Step 1: Agregar cache de vendedores**

En `app.js:1905-1907`, junto a las declaraciones existentes:

```js
let movimientosCache = [];
let almacenesCache = [];
let productosParaMovimientoCache = [];
let vendedoresParaConsignaCache = [];
let movimientoReciboFolioActual = null;
```

- [ ] **Step 2: Actualizar `openMovimientoForm()` para resetear los 3 tipos y cargar vendedores**

Reemplaza la función completa (`app.js:2031-2065`) por:

```js
async function openMovimientoForm() {
  document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tipo === 'entrada');
  });
  document.getElementById('movimiento-origen-row').style.display = 'none';
  document.getElementById('movimiento-destino-row').style.display = 'none';
  document.getElementById('movimiento-producto-row').style.display = 'block';
  document.getElementById('movimiento-cantidad-row').style.display = 'block';
  document.getElementById('movimiento-vendedor-row').style.display = 'none';
  document.getElementById('movimiento-monto-row').style.display = 'none';
  document.getElementById('movimiento-cantidad').value = '';
  document.getElementById('movimiento-monto').value = '';
  document.getElementById('movimiento-form-error').textContent = '';
  document.getElementById('movimiento-paso-armar').style.display = 'block';
  document.getElementById('movimiento-paso-recibo').style.display = 'none';

  await loadAlmacenes();

  const { data: productos } = await supabase.from('productos').select('id, nombre').order('nombre');
  productosParaMovimientoCache = productos || [];

  const productoSelect = document.getElementById('movimiento-producto');
  productoSelect.innerHTML = '';
  productosParaMovimientoCache.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.nombre;
    productoSelect.appendChild(opt);
  });

  [document.getElementById('movimiento-origen'), document.getElementById('movimiento-destino')].forEach((select) => {
    select.innerHTML = '';
    almacenesCache.forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = nombreAlmacen(a);
      select.appendChild(opt);
    });
  });

  const { data: vendedores } = await supabase
    .from('usuarios')
    .select('id, nombre')
    .eq('rol', 'vendedor')
    .eq('activo', true)
    .order('nombre');
  vendedoresParaConsignaCache = vendedores || [];

  const vendedorSelect = document.getElementById('movimiento-vendedor');
  vendedorSelect.innerHTML = '';
  vendedoresParaConsignaCache.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.nombre;
    vendedorSelect.appendChild(opt);
  });

  document.getElementById('movimiento-sheet').classList.add('show');
}
```

- [ ] **Step 3: Reescribir `guardarMovimiento()` con la rama de pago de consigna**

Reemplaza la función completa (`app.js:2071-2151`) por:

```js
async function guardarMovimiento() {
  if (!assertOnline()) return;

  const tipo = document.querySelector('#movimiento-tipo-toggle .toggle-btn.active').dataset.tipo;
  const errorEl = document.getElementById('movimiento-form-error');
  const btn = document.getElementById('movimiento-guardar');

  errorEl.textContent = '';

  if (tipo === 'pago_consigna') {
    const vendedorId = document.getElementById('movimiento-vendedor').value;
    const monto = parseFloat(document.getElementById('movimiento-monto').value);
    const vendedor = vendedoresParaConsignaCache.find((v) => v.id === vendedorId);

    if (!vendedorId) {
      errorEl.textContent = 'Selecciona un vendedor.';
      return;
    }
    if (!Number.isFinite(monto) || monto <= 0) {
      errorEl.textContent = 'El monto debe ser mayor a $0.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const session = getSession();
      const { data, error } = await supabase.rpc('registrar_pago_consigna', {
        p_vendedor_id: vendedorId,
        p_monto: monto,
        p_usuario_id: session.id,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('MONTO_EXCEDE_DEUDA')) {
          errorEl.textContent = 'Ese pago es mayor a la deuda de consigna actual del vendedor.';
        } else if (msg.includes('PERMISO_DENEGADO')) {
          errorEl.textContent = 'Solo un administrador puede registrar/anular pagos de consigna.';
        } else {
          errorEl.textContent = 'No se pudo registrar el pago. Intenta de nuevo.';
        }
        return;
      }

      const resultado = data[0];
      mostrarReciboPagoConsigna({
        folio: resultado.folio,
        monto,
        deudaRestante: Number(resultado.deuda_restante),
        vendedor: vendedor ? vendedor.nombre : '',
        registradoPor: session.nombre,
        fecha: new Date(),
      });

      loadMovimientos();
      loadDeudaConsigna();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
    return;
  }

  const productoId = document.getElementById('movimiento-producto').value;
  const cantidad = parseInt(document.getElementById('movimiento-cantidad').value, 10);

  if (!productoId) {
    errorEl.textContent = 'Selecciona un producto.';
    return;
  }
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    errorEl.textContent = 'La cantidad debe ser un número entero mayor a 0.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    const session = getSession();

    if (tipo === 'entrada') {
      const { error } = await supabase.rpc('registrar_entrada', {
        p_producto_id: productoId,
        p_cantidad: cantidad,
        p_usuario_id: session.id,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('PERMISO_DENEGADO')) {
          errorEl.textContent = 'Solo un administrador puede registrar/anular movimientos de almacén.';
        } else {
          errorEl.textContent = 'No se pudo registrar la entrada. Intenta de nuevo.';
        }
        return;
      }
    } else {
      const origenId = document.getElementById('movimiento-origen').value;
      const destinoId = document.getElementById('movimiento-destino').value;

      if (origenId === destinoId) {
        errorEl.textContent = 'El almacén de origen y destino no pueden ser el mismo.';
        return;
      }

      const { error } = await supabase.rpc('registrar_traspaso', {
        p_producto_id: productoId,
        p_almacen_origen_id: origenId,
        p_almacen_destino_id: destinoId,
        p_cantidad: cantidad,
        p_usuario_id: session.id,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('STOCK_INSUFICIENTE')) {
          errorEl.textContent = 'Ese almacén no tiene suficiente cantidad para traspasar.';
        } else if (msg.includes('MOVIMIENTO_INVALIDO')) {
          errorEl.textContent = 'El almacén de origen y destino no pueden ser el mismo.';
        } else {
          errorEl.textContent = 'No se pudo registrar el traspaso. Intenta de nuevo.';
        }
        return;
      }
    }

    closeMovimientoForm();
    toast(tipo === 'entrada' ? 'Entrada registrada.' : 'Traspaso registrado.');
    loadMovimientos();
    loadDeudaConsigna();
    loadProductos();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}

function mostrarReciboPagoConsigna(info) {
  const cont = document.getElementById('movimiento-recibo-contenido');
  movimientoReciboFolioActual = info.folio;
  cont.innerHTML = `
    <div class="recibo-linea"><span>Folio</span><span>${escapeHtml(info.folio)}</span></div>
    <div class="recibo-linea"><span>Fecha</span><span>${fechaFmt.format(info.fecha)}</span></div>
    <div class="recibo-linea"><span>Registrado por</span><span>${escapeHtml(info.registradoPor)}</span></div>
    <div class="recibo-linea"><span>Vendedor</span><span>${escapeHtml(info.vendedor)}</span></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">
    <div class="recibo-linea total"><span>Monto pagado</span><span>${money.format(info.monto)}</span></div>
    <div class="recibo-linea"><span>Deuda de consigna restante</span><span>${money.format(info.deudaRestante)}</span></div>
  `;

  document.getElementById('movimiento-paso-armar').style.display = 'none';
  document.getElementById('movimiento-paso-recibo').style.display = 'block';
  document.getElementById('movimiento-recibo-whatsapp').style.display = soportaCompartirArchivos() ? 'block' : 'none';
}
```

- [ ] **Step 4: Actualizar `initMovimientos()` para el toggle de 3 opciones y los botones del recibo**

Reemplaza la función completa (`app.js:2153-2171`) por:

```js
function initMovimientos() {
  document.getElementById('btn-movimientos').addEventListener('click', openMovimientosPanel);
  document.getElementById('movimientos-cerrar').addEventListener('click', closeMovimientosPanel);
  document.getElementById('fab-nuevo-movimiento').addEventListener('click', openMovimientoForm);
  document.getElementById('movimiento-cancelar').addEventListener('click', closeMovimientoForm);
  document.getElementById('movimiento-guardar').addEventListener('click', guardarMovimiento);
  document.getElementById('movimiento-recibo-cerrar').addEventListener('click', closeMovimientoForm);
  document.getElementById('movimiento-recibo-pdf').addEventListener('click', (e) => {
    descargarReciboPDF(document.getElementById('movimiento-recibo-contenido'), movimientoReciboFolioActual, e.currentTarget);
  });
  document.getElementById('movimiento-recibo-whatsapp').addEventListener('click', (e) => {
    compartirReciboWhatsApp(document.getElementById('movimiento-recibo-contenido'), movimientoReciboFolioActual, e.currentTarget);
  });

  document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const tipo = btn.dataset.tipo;
      const esTraspaso = tipo === 'traspaso';
      const esPagoConsigna = tipo === 'pago_consigna';

      document.getElementById('movimiento-origen-row').style.display = esTraspaso ? 'block' : 'none';
      document.getElementById('movimiento-destino-row').style.display = esTraspaso ? 'block' : 'none';
      document.getElementById('movimiento-producto-row').style.display = esPagoConsigna ? 'none' : 'block';
      document.getElementById('movimiento-cantidad-row').style.display = esPagoConsigna ? 'none' : 'block';
      document.getElementById('movimiento-vendedor-row').style.display = esPagoConsigna ? 'block' : 'none';
      document.getElementById('movimiento-monto-row').style.display = esPagoConsigna ? 'block' : 'none';
    });
  });
}
```

- [ ] **Step 5: Verificar manualmente en el navegador**

No hay test runner — usa las herramientas de preview del navegador: abre la app, entra como
admin, ve a Inicio → "📦 Movimientos" → botón (+) → toca "Pago consigna" → confirma que
Producto/Origen/Destino/Cantidad se ocultan y aparecen Vendedor/Monto. Selecciona un
vendedor con deuda > 0, ingresa un monto menor a su deuda, guarda, y confirma que aparece
el recibo con folio, monto y deuda restante correctos (compáralos contra lo que viste en el
resumen "Deuda de consigna por vendedor" antes de pagar — deben cuadrar con
`deuda_anterior - monto`).

---

### Task 7: JS — resumen "Deuda por vendedor" en Movimientos

**Files:**
- Modify: `app.js:2020-2025` (`openMovimientosPanel`)
- Modify: cerca de `app.js:1941` (agregar `loadDeudaConsigna`/`renderDeudaConsigna` antes de
  `renderMovimientos`)

**Interfaces:**
- Consume: `usuarios.deuda_consigna` (Task 1), `escapeHtml`, `money` (ya existen).
- Produce: `loadDeudaConsigna()` — llamada también por Task 6 (tras pago/traspaso/entrada) y
  Task 8 (tras anular pago de consigna).

- [ ] **Step 1: Agregar `loadDeudaConsigna()` / `renderDeudaConsigna()`**

Inserta justo antes de `function renderMovimientos()` (`app.js:1941`):

```js
let deudaConsignaCache = [];

async function loadDeudaConsigna() {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nombre, deuda_consigna')
    .eq('rol', 'vendedor')
    .order('nombre');

  if (error) {
    deudaConsignaCache = [];
    renderDeudaConsigna();
    return;
  }

  deudaConsignaCache = data || [];
  renderDeudaConsigna();
}

function renderDeudaConsigna() {
  const list = document.getElementById('consigna-deuda-list');
  const empty = document.getElementById('consigna-deuda-empty');
  list.innerHTML = '';
  empty.style.display = deudaConsignaCache.length === 0 ? 'block' : 'none';

  deudaConsignaCache.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main"><div class="li-title">${escapeHtml(v.nombre)}</div></div>
      <div class="li-badge ${Number(v.deuda_consigna) > 0 ? 'pendiente' : 'al-dia'}">${money.format(Number(v.deuda_consigna))}</div>
    `;
    list.appendChild(item);
  });
}
```

- [ ] **Step 2: Cargar la deuda al abrir el panel**

Reemplaza `openMovimientosPanel()` (`app.js:2020-2025`) por:

```js
async function openMovimientosPanel() {
  const session = getSession();
  document.getElementById('fab-nuevo-movimiento').classList.toggle('show', session.rol === 'admin');
  document.getElementById('movimientos-panel').classList.add('show');
  await Promise.all([loadMovimientos(), loadDeudaConsigna()]);
}
```

- [ ] **Step 3: Verificar en el navegador**

Abre "📦 Movimientos" y confirma que aparecen los 3 vendedores (Angie, Alexa, Alexis) con su
deuda actual, incluidos los que están en $0.00 (deben verse en verde/"al-dia", no en rojo
como los que tienen deuda pendiente — reutiliza el mismo estilo de badge que ya usa la
lista de usuarios en Mi Cuenta).

---

### Task 8: JS — historial mezclado (movimientos + pagos de consigna) y anular pago

**Files:**
- Modify: `app.js:1916-1939` (`loadMovimientos`)
- Modify: `app.js:1941-1979` (`renderMovimientos`)
- Modify: cerca de `app.js:2018` (agregar `confirmarAnularPagoConsigna` después de
  `confirmarAnularMovimiento`)

**Interfaces:**
- Consume: `registrar_pago_consigna`/`anular_pago_consigna` (Task 4), `loadDeudaConsigna`
  (Task 7).
- Produce: `movimientosCache` cambia de forma — ahora cada elemento es
  `{ kind: 'movimiento' | 'pago_consigna', creadoEn: Date, data: {...} }` en vez de la fila
  cruda de `movimientos_almacen`. Ningún otro archivo lee `movimientosCache` fuera de
  `app.js`, así que este cambio de forma es interno.

- [ ] **Step 1: Reescribir `loadMovimientos()` para traer y mezclar ambas fuentes**

Reemplaza la función completa (`app.js:1916-1939`) por:

```js
async function loadMovimientos() {
  const [{ data: movs, error: movsError }, { data: pagos, error: pagosError }] = await Promise.all([
    supabase
      .from('movimientos_almacen')
      .select(`
        id, cantidad, creado_en, anulado, anulado_en,
        producto:productos(nombre),
        origen:almacenes!movimientos_almacen_almacen_origen_id_fkey(usuario_id, usuarios(nombre)),
        destino:almacenes!movimientos_almacen_almacen_destino_id_fkey(usuario_id, usuarios(nombre)),
        usuario:usuarios!movimientos_almacen_usuario_id_fkey(nombre),
        anulador:usuarios!movimientos_almacen_anulado_por_fkey(nombre)
      `)
      .order('creado_en', { ascending: false })
      .limit(200),
    supabase
      .from('pagos_consigna')
      .select(`
        id, monto, deuda_restante, creado_en, anulado, anulado_en,
        vendedor:usuarios!pagos_consigna_vendedor_id_fkey(nombre),
        usuario:usuarios!pagos_consigna_usuario_id_fkey(nombre),
        anulador:usuarios!pagos_consigna_anulado_por_fkey(nombre)
      `)
      .order('creado_en', { ascending: false })
      .limit(200),
  ]);

  if (movsError || pagosError) {
    toast('No se pudo cargar los movimientos.', 'error');
    movimientosCache = [];
    renderMovimientos();
    return;
  }

  const itemsMov = (movs || []).map((m) => ({ kind: 'movimiento', creadoEn: new Date(m.creado_en), data: m }));
  const itemsPago = (pagos || []).map((p) => ({ kind: 'pago_consigna', creadoEn: new Date(p.creado_en), data: p }));

  movimientosCache = [...itemsMov, ...itemsPago].sort((a, b) => b.creadoEn - a.creadoEn);
  renderMovimientos();
}
```

- [ ] **Step 2: Reescribir `renderMovimientos()` para branchear por `kind`**

Reemplaza la función completa (`app.js:1941-1979`) por:

```js
function renderMovimientos() {
  const list = document.getElementById('movimientos-list');
  const empty = document.getElementById('movimientos-empty');
  const session = getSession();

  list.innerHTML = '';
  empty.style.display = movimientosCache.length === 0 ? 'block' : 'none';

  movimientosCache.forEach((item) => {
    const card = document.createElement('div');

    if (item.kind === 'pago_consigna') {
      const p = item.data;
      const anuladoTag = p.anulado
        ? '<div class="li-sub historial-anulado-tag">Anulado</div>'
        : '';

      card.className = 'list-item historial-item' + (p.anulado ? ' anulado' : '');
      card.innerHTML = `
        <div class="li-main">
          <div class="li-title">Pago de consigna: ${escapeHtml(p.vendedor.nombre)} · ${money.format(Number(p.monto))}</div>
          <div class="li-sub">${escapeHtml(p.usuario.nombre)} · ${fechaFmt.format(new Date(p.creado_en))}</div>
          ${anuladoTag}
        </div>
        <div class="historial-item-right">
          ${session && session.rol === 'admin' && !p.anulado ? '<button type="button" class="btn-anular">Anular</button>' : ''}
        </div>
      `;

      if (session && session.rol === 'admin' && !p.anulado) {
        card.querySelector('.btn-anular').addEventListener('click', (e) => {
          confirmarAnularPagoConsigna(p.id, e.currentTarget);
        });
      }

      list.appendChild(card);
      return;
    }

    const m = item.data;
    const descripcion = m.origen
      ? `Traspaso: ${escapeHtml(nombreAlmacen(m.origen))} → ${escapeHtml(nombreAlmacen(m.destino))}`
      : `Entrada → ${escapeHtml(nombreAlmacen(m.destino))}`;

    const anuladoTag = m.anulado
      ? '<div class="li-sub historial-anulado-tag">Anulado</div>'
      : '';

    card.className = 'list-item historial-item' + (m.anulado ? ' anulado' : '');
    card.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(m.producto.nombre)} · ${descripcion}</div>
        <div class="li-sub">${m.cantidad} unidades · ${escapeHtml(m.usuario.nombre)} · ${fechaFmt.format(new Date(m.creado_en))}</div>
        ${anuladoTag}
      </div>
      <div class="historial-item-right">
        ${session && session.rol === 'admin' && !m.anulado ? '<button type="button" class="btn-anular">Anular</button>' : ''}
      </div>
    `;

    if (session && session.rol === 'admin' && !m.anulado) {
      card.querySelector('.btn-anular').addEventListener('click', (e) => {
        confirmarAnularMovimiento(m.id, e.currentTarget);
      });
    }

    list.appendChild(card);
  });
}
```

- [ ] **Step 3: Agregar `confirmarAnularPagoConsigna()` y refrescar deuda al anular movimientos**

Inserta después de `confirmarAnularMovimiento()` (después de `app.js:2018`):

```js
async function confirmarAnularPagoConsigna(pagoId, btn) {
  if (!assertOnline()) return;

  const ok = window.confirm('¿Seguro que quieres anular este pago de consigna? No se puede deshacer.');
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Anulando...';

  try {
    const session = getSession();
    const { error } = await supabase.rpc('anular_pago_consigna', {
      p_pago_id: pagoId,
      p_usuario_id: session.id,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('YA_ANULADO')) {
        toast('Ese pago ya estaba anulado.', 'error');
      } else if (msg.includes('PERMISO_DENEGADO')) {
        toast('Solo un administrador puede registrar/anular pagos de consigna.', 'error');
      } else {
        toast('No se pudo anular. Intenta de nuevo.', 'error');
      }
      return;
    }

    toast('Pago de consigna anulado.');
    loadMovimientos();
    loadDeudaConsigna();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anular';
  }
}
```

También añade `loadDeudaConsigna();` justo después de `loadMovimientos();` dentro de
`confirmarAnularMovimiento()` (el `try` que ya existe, después de `toast('Movimiento
anulado.')`), para que anular un traspaso refresque el resumen de deuda visible.

- [ ] **Step 4: Verificar en el navegador**

Registra un pago de consigna (Task 6), confirma que aparece en el historial mezclado con el
texto "Pago de consigna: {vendedor} · {monto}" en el orden cronológico correcto entre
entradas/traspasos existentes. Anúlalo con el botón "Anular", confirma el mensaje de
confirmación, y que tanto el historial (tag "Anulado") como el resumen "Deuda de consigna
por vendedor" se actualizan de vuelta al monto previo al pago.

---

### Task 9: Reportes — deuda total de consigna + listado por vendedor

**Files:**
- Modify: `app.js:1479-1525` (`loadReportes`)
- Modify: cerca de `app.js:1555` (agregar `renderReportesConsigna` junto a
  `renderReportesSaldos`)

**Interfaces:**
- Consume: `usuarios.deuda_consigna` (Task 1), `money`, `escapeHtml` (ya existen).
- Produce: nada consumido por otras tasks — es la última pieza de UI.

- [ ] **Step 1: Extender `loadReportes()` con la consulta de deuda de consigna**

Reemplaza el bloque `Promise.all` y la validación de errores de `loadReportes()`
(`app.js:1486-1524`) por:

```js
  const [
    { data: ventasPeriodo, error: ventasError },
    { data: abonosPeriodo, error: abonosError },
    { data: clientesSaldo, error: clientesError },
    { data: pagosPeriodo, error: pagosError },
    { data: itemsPeriodo, error: itemsError },
    { data: vendedoresConsigna, error: consignaError },
  ] = await Promise.all([
    supabase.from('ventas')
      .select('id, total, vendedor:usuarios!ventas_vendedor_id_fkey(nombre)')
      .eq('anulado', false).gte('creado_en', inicioISO).lt('creado_en', finISO),
    supabase.from('abonos')
      .select('monto, vendedor:usuarios!abonos_vendedor_id_fkey(nombre)')
      .eq('anulado', false).gte('creado_en', inicioISO).lt('creado_en', finISO),
    supabase.from('clientes')
      .select('id, nombre, saldo_pendiente')
      .gt('saldo_pendiente', 0).order('saldo_pendiente', { ascending: false }),
    supabase.from('venta_pagos')
      .select('monto, utilidad_realizada, creado_en, venta:ventas!inner(anulado, vendedor:usuarios!ventas_vendedor_id_fkey(nombre))')
      .gte('creado_en', inicioISO).lt('creado_en', finISO)
      .eq('venta.anulado', false),
    supabase.from('venta_items')
      .select(`
        cantidad, precio_unitario, costo_unitario,
        producto:productos(nombre),
        venta:ventas!inner(folio, creado_en, anulado, vendedor:usuarios!ventas_vendedor_id_fkey(nombre))
      `)
      .gte('venta.creado_en', inicioISO).lt('venta.creado_en', finISO)
      .eq('venta.anulado', false),
    supabase.from('usuarios')
      .select('id, nombre, deuda_consigna')
      .eq('rol', 'vendedor').gt('deuda_consigna', 0)
      .order('deuda_consigna', { ascending: false }),
  ]);

  if (ventasError || abonosError || clientesError || pagosError || itemsError || consignaError) {
    toast('No se pudo cargar Reportes.', 'error');
    return;
  }

  renderReportesTotales(ventasPeriodo || [], pagosPeriodo || []);
  renderReportesSaldos(clientesSaldo || []);
  renderReportesConsigna(vendedoresConsigna || []);
  renderReportesVendedores(ventasPeriodo || [], abonosPeriodo || [], pagosPeriodo || []);
  renderReportesDetalle(itemsPeriodo || []);
}
```

- [ ] **Step 2: Agregar `renderReportesConsigna()`**

Inserta después de `renderReportesSaldos()` (después de `app.js:1555`):

```js
function renderReportesConsigna(vendedores) {
  const total = vendedores.reduce((sum, v) => sum + Number(v.deuda_consigna), 0);
  document.getElementById('rep-consigna-total').textContent = money.format(total);

  const list = document.getElementById('rep-consigna-list');
  const empty = document.getElementById('rep-consigna-empty');
  list.innerHTML = '';
  empty.style.display = vendedores.length === 0 ? 'block' : 'none';

  vendedores.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main"><div class="li-title">${escapeHtml(v.nombre)}</div></div>
      <div class="li-badge pendiente">${money.format(Number(v.deuda_consigna))}</div>
    `;
    list.appendChild(item);
  });
}
```

- [ ] **Step 3: Verificar en el navegador**

Abre la pestaña Reportes y confirma que aparece "Deuda de consigna pendiente (a hoy)" entre
"Saldo pendiente del negocio" y "Por vendedor", con el total correcto (suma de las deudas
que viste en Movimientos) y el listado ordenado de mayor a menor. Si ningún vendedor tiene
deuda, confirma que se muestra el mensaje vacío en vez de una lista en blanco.

---

### Task 10: Cache bump, checklist de prueba manual completo, y despliegue

**Files:**
- Modify: `sw.js:1`

**Interfaces:**
- Ninguna — task de cierre.

- [ ] **Step 1: Subir la versión de caché**

En `sw.js:1`, cambia:

```js
const CACHE = 'vf-v11';
```

por:

```js
const CACHE = 'vf-v12';
```

- [ ] **Step 2: Checklist de prueba manual en navegador real (antes de subir)**

Usando las herramientas de preview del navegador (`preview_start` apuntando a este
directorio servido localmente, o el deploy de Vercel si ya está arriba), como usuario
admin (Papá):

1. Login como Papá → Movimientos → confirma que el resumen "Deuda de consigna por
   vendedor" carga sin error de consola y muestra a los 3 vendedores.
2. Registra una Entrada de un producto a Central, luego un Traspaso Central→Angie —
   confirma que la deuda de Angie sube exactamente `cantidad × costo` del producto.
3. Registra un Pago de consigna de Angie por un monto menor a su deuda — confirma el
   recibo (folio, monto, deuda restante), descarga el PDF, y si el dispositivo soporta
   compartir, prueba el botón de WhatsApp.
4. Intenta un Pago de consigna mayor a la deuda actual de un vendedor — confirma el
   mensaje de error "Ese pago es mayor a la deuda de consigna actual del vendedor." y que
   no se registra nada.
5. Anula el pago de consigna del paso 3 — confirma que la deuda de Angie vuelve a subir y
   que el historial marca el renglón como "Anulado".
6. Anula el traspaso del paso 2 (sin haberlo vendido/retraspasado aún) — confirma que la
   deuda de Angie baja de vuelta a 0 y el stock revierte a Central.
7. Login como un vendedor (Angie) — confirma que ve el resumen de deuda y el historial
   completo (transparencia), pero **no** ve el botón (+) ni ningún botón "Anular".
8. Ve a Reportes → confirma que "Deuda de consigna pendiente (a hoy)" muestra el total y
   listado correctos, consistentes con lo visto en Movimientos.
9. Revisa la consola del navegador (`read_console_messages`) en cada paso — cero errores.

- [ ] **Step 3: Commit y push**

```bash
git add -A
git commit -m "Ticket 14: deuda de consigna por vendedor"
git push
```

Esto dispara el redeploy automático en Vercel (`ventas-familia.vercel.app`). No hace falta
ningún paso manual adicional en Vercel.

- [ ] **Step 4: Actualizar TICKETS.md y CLAUDE.md**

En `TICKETS.md`, agrega el ticket 14 a la lista de completados con su checklist (mismo
formato que ticket 13). En `CLAUDE.md` (sección "Progreso"), añade "14 (deuda de consigna
por vendedor)" a la lista de completados y actualiza la línea de "Pendiente" si aplica.
