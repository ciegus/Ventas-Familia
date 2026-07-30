# Ganancia neta por vendedor + Reportes (ticket 11) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Reportes tab (ticket 11) with a month-by-month business summary, and add cost/profit tracking so each vendor's net profit (sale price minus product cost) is calculated correctly — even across shared, FIFO-settled client balances — while keeping product cost hidden-by-default wherever a customer might glance at a phone screen.

**Architecture:** Four Postgres `SECURITY DEFINER` functions already do all the atomic accounting for this app (`registrar_venta`, `registrar_abono`, `anular_venta`, `anular_abono`) — this plan extends each of them rather than adding new call sites. A new `venta_pagos` ledger table records every real cash event (the immediate payment at sale time, or each FIFO-allocated abono) together with the profit it realized, tagged back to the original selling vendor. The frontend (plain JS, no framework, no build step) gains: an editable per-line sale price and a cost-reveal toggle in the sale cart, a cost field + toggle in Inventory, and a full Reportes tab that queries `venta_pagos`/`venta_items` directly via `supabase-js`.

**Tech Stack:** Supabase Postgres (plpgsql functions via MCP `apply_migration`), vanilla JS ES module (`app.js`), plain HTML/CSS (no build step, no test framework — this project is verified by manual browser testing per its established convention).

## Global Constraints

- No local `.sql` files — this project's schema and functions live only in Supabase; every DB change here goes through the Supabase MCP `apply_migration` tool against project `ventas-familia` (`project_id: wiewxgkiefsjeonirsid`), matching how tickets 01/07/08 were built.
- No build step — `index.html`/`app.js`/`styles.css` are edited directly, no bundler.
- Any write operation must still call `assertOnline()` first (existing convention, SPEC sección 9) — none of the new writes bypass this.
- Money formatting always via the existing `money` (`Intl.NumberFormat('es-MX', ...)`) and `fechaFmt`/new date formatters follow the same `Intl.DateTimeFormat('es-MX', ...)` pattern already used in `app.js`.
- Every time `app.js` or `styles.css` changes, bump `sw.js` → `const CACHE = 'vf-vX'` (currently `vf-v3`) before the final commit (project convention).
- Reportes is tables/text only — no charts (SPEC sección 11).
- Full design context: [docs/superpowers/specs/2026-07-30-ganancia-por-vendedor-design.md](../specs/2026-07-30-ganancia-por-vendedor-design.md).

---

## Task 1: Schema migration — costo, costo_unitario, costo_total, saldo_pendiente_venta, venta_pagos

**Files:**
- Supabase (via MCP `apply_migration`, project_id `wiewxgkiefsjeonirsid`) — no local file.

**Interfaces:**
- Produces: `productos.costo` (numeric, not null, > 0), `venta_items.costo_unitario` (numeric, not null, >= 0), `ventas.costo_total` (numeric, not null, >= 0), `ventas.saldo_pendiente_venta` (numeric, not null, >= 0), new table `venta_pagos(id, venta_id, abono_id, monto, utilidad_realizada, creado_en)`. Tasks 2–8 depend on all of these existing exactly as named here.

- [ ] **Step 1: Apply the migration**

Call the Supabase MCP `apply_migration` tool with `project_id: "wiewxgkiefsjeonirsid"` and this SQL:

```sql
-- productos: costo obligatorio (backfill del único producto existente antes del NOT NULL)
alter table productos add column costo numeric;
update productos set costo = 150.00 where nombre = 'Playera polo azul';
alter table productos alter column costo set not null;
alter table productos add constraint productos_costo_check check (costo > 0);

-- venta_items: snapshot de costo por línea (default temporal para no romper las 13 filas existentes)
alter table venta_items add column costo_unitario numeric not null default 0;
alter table venta_items alter column costo_unitario drop default;
alter table venta_items add constraint venta_items_costo_check check (costo_unitario >= 0);

-- ventas: snapshot de costo total + saldo pendiente propio de esa venta (solo aplica a crédito)
alter table ventas add column costo_total numeric not null default 0;
alter table ventas alter column costo_total drop default;
alter table ventas add constraint ventas_costo_total_check check (costo_total >= 0);
alter table ventas add column saldo_pendiente_venta numeric not null default 0;
alter table ventas add constraint ventas_saldo_pendiente_venta_check check (saldo_pendiente_venta >= 0);

-- venta_pagos: cada cobro real (enganche/contado o abono aplicado) con su ganancia ya calculada
create table venta_pagos (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ventas(id),
  abono_id uuid references abonos(id),
  monto numeric not null check (monto > 0),
  utilidad_realizada numeric not null,
  creado_en timestamptz not null default now()
);
create index venta_pagos_venta_id_idx on venta_pagos(venta_id);
create index venta_pagos_abono_id_idx on venta_pagos(abono_id);
```

- [ ] **Step 2: Verify the migration**

Run via the Supabase MCP `execute_sql` tool (project_id `wiewxgkiefsjeonirsid`):

```sql
select
  (select costo from productos where nombre = 'Playera polo azul') as costo_migrado,
  (select count(*) from venta_items where costo_unitario is null) as venta_items_null_count,
  (select count(*) from ventas where costo_total is null or saldo_pendiente_venta is null) as ventas_null_count,
  (select count(*) from information_schema.tables where table_name = 'venta_pagos') as venta_pagos_existe;
```

Expected: `costo_migrado = 150.00`, both `_null_count` columns = `0`, `venta_pagos_existe = 1`.

- [ ] **Step 3: Confirm constraints reject bad data**

Run via `execute_sql` (this must fail — that's the point):

```sql
insert into productos (nombre, precio, costo, foto_url, stock) values ('TEST_QA_costo0', 10, 0, 'http://example.com/x.png', 1);
```

Expected: error violating `productos_costo_check`. If it succeeds instead, the constraint didn't apply — stop and fix before continuing.

---

## Task 2: Rework `registrar_venta()` — precio editable por línea + snapshot de costo + venta_pagos inicial

**Files:**
- Supabase (via MCP `apply_migration`) — no local file.

**Interfaces:**
- Consumes: `venta_pagos` table from Task 1.
- Produces: `registrar_venta(p_tipo text, p_cliente_id uuid, p_vendedor_id uuid, p_enganche numeric, p_items jsonb)` — **signature change**: each object in `p_items` now requires `{producto_id, cantidad, precio_unitario}` (was `{producto_id, cantidad}` — `precio_unitario` is new and required). Task 7 (frontend) must send this new shape. Return shape unchanged: `TABLE(folio text, total numeric)`.

- [ ] **Step 1: Apply the new function**

```sql
CREATE OR REPLACE FUNCTION public.registrar_venta(p_tipo text, p_cliente_id uuid, p_vendedor_id uuid, p_enganche numeric, p_items jsonb)
 RETURNS TABLE(folio text, total numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_folio text;
  v_total numeric := 0;
  v_costo_total numeric := 0;
  v_venta_id uuid;
  v_item record;
  v_stock int;
  v_costo numeric;
  v_enganche numeric := coalesce(p_enganche, 0);
  v_pago_inmediato numeric;
  v_utilidad numeric;
begin
  if p_tipo not in ('contado', 'credito') then
    raise exception 'Tipo de venta inválido';
  end if;

  if p_tipo = 'credito' and p_cliente_id is null then
    raise exception 'La venta a crédito requiere un cliente';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta debe tener al menos un producto';
  end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(producto_id uuid, cantidad int, precio_unitario numeric)
  loop
    if v_item.cantidad is null or v_item.cantidad <= 0 then
      raise exception 'Cantidad inválida';
    end if;
    if v_item.precio_unitario is null or v_item.precio_unitario <= 0 then
      raise exception 'Precio inválido';
    end if;

    select stock, costo into v_stock, v_costo from productos where id = v_item.producto_id for update;
    if not found then
      raise exception 'Producto no encontrado';
    end if;
    if v_stock < v_item.cantidad then
      raise exception 'STOCK_INSUFICIENTE';
    end if;

    v_total := v_total + (v_item.precio_unitario * v_item.cantidad);
    v_costo_total := v_costo_total + (v_costo * v_item.cantidad);
  end loop;

  if v_enganche < 0 or v_enganche > v_total then
    raise exception 'Enganche inválido';
  end if;

  v_folio := generate_folio();

  insert into ventas (folio, tipo, cliente_id, vendedor_id, total, enganche, costo_total, saldo_pendiente_venta)
  values (
    v_folio, p_tipo, p_cliente_id, p_vendedor_id, v_total, v_enganche, v_costo_total,
    case when p_tipo = 'credito' then v_total - v_enganche else 0 end
  )
  returning id into v_venta_id;

  for v_item in select * from jsonb_to_recordset(p_items) as x(producto_id uuid, cantidad int, precio_unitario numeric)
  loop
    select costo into v_costo from productos where id = v_item.producto_id;

    insert into venta_items (venta_id, producto_id, cantidad, precio_unitario, costo_unitario)
    values (v_venta_id, v_item.producto_id, v_item.cantidad, v_item.precio_unitario, v_costo);

    update productos set stock = stock - v_item.cantidad where id = v_item.producto_id;
  end loop;

  v_pago_inmediato := case when p_tipo = 'credito' then v_enganche else v_total end;

  if v_pago_inmediato > 0 then
    v_utilidad := round(v_pago_inmediato - (v_costo_total * (v_pago_inmediato / v_total)), 2);
    insert into venta_pagos (venta_id, abono_id, monto, utilidad_realizada)
    values (v_venta_id, null, v_pago_inmediato, v_utilidad);
  end if;

  if p_tipo = 'credito' then
    update clientes set saldo_pendiente = saldo_pendiente + (v_total - v_enganche) where id = p_cliente_id;
  end if;

  return query select v_folio, v_total;
end;
$function$
```

- [ ] **Step 2: Verify — venta de contado**

Run via `execute_sql` (uses the real "Playera polo azul" product, precio_unitario deliberately different from its catalog `precio` of $250 to prove the client-supplied price is respected):

```sql
do $$
declare
  v_producto_id uuid;
  v_vendedor_id uuid;
  v_result record;
  v_venta_id uuid;
  v_pago record;
begin
  select id into v_producto_id from productos where nombre = 'Playera polo azul';
  select id into v_vendedor_id from usuarios where nombre = 'Angie';

  select * into v_result from registrar_venta(
    'contado', null, v_vendedor_id, 0,
    jsonb_build_array(jsonb_build_object('producto_id', v_producto_id, 'cantidad', 2, 'precio_unitario', 300))
  );

  select id into v_venta_id from ventas where folio = v_result.folio;
  select * into v_pago from venta_pagos where venta_id = v_venta_id;

  assert v_result.total = 600, 'total esperado 600, fue ' || v_result.total;
  assert (select costo_total from ventas where id = v_venta_id) = 300, 'costo_total esperado 300 (2 x 150)';
  assert v_pago.utilidad_realizada = 300, 'ganancia esperada 300 (600-300), fue ' || v_pago.utilidad_realizada;

  -- limpieza
  delete from venta_pagos where venta_id = v_venta_id;
  delete from venta_items where venta_id = v_venta_id;
  update productos set stock = stock + 2 where id = v_producto_id;
  delete from ventas where id = v_venta_id;

  raise notice 'OK: venta de contado con precio editable calcula costo y ganancia correctamente';
end $$;
```

Expected: `NOTICE: OK: ...`, no assertion errors. If any `assert` fails, the message tells you which number is wrong — fix the function before continuing.

- [ ] **Step 3: Verify — venta a crédito con enganche**

```sql
do $$
declare
  v_producto_id uuid;
  v_vendedor_id uuid;
  v_cliente_id uuid;
  v_result record;
  v_venta_id uuid;
  v_pago record;
begin
  select id into v_producto_id from productos where nombre = 'Playera polo azul';
  select id into v_vendedor_id from usuarios where nombre = 'Angie';
  insert into clientes (nombre) values ('TEST_QA_credito') returning id into v_cliente_id;

  -- 1 pieza a $300 (costo $150) con enganche de $100 sobre un total de $300
  select * into v_result from registrar_venta(
    'credito', v_cliente_id, v_vendedor_id, 100,
    jsonb_build_array(jsonb_build_object('producto_id', v_producto_id, 'cantidad', 1, 'precio_unitario', 300))
  );

  select id into v_venta_id from ventas where folio = v_result.folio;
  select * into v_pago from venta_pagos where venta_id = v_venta_id;

  assert (select saldo_pendiente_venta from ventas where id = v_venta_id) = 200, 'saldo_pendiente_venta esperado 200 (300-100)';
  assert (select saldo_pendiente from clientes where id = v_cliente_id) = 200, 'saldo del cliente esperado 200';
  -- ratio de ganancia = (300-150)/300 = 0.5 -> ganancia del enganche = 100 * 0.5 = 50
  assert v_pago.utilidad_realizada = 50, 'ganancia del enganche esperada 50, fue ' || v_pago.utilidad_realizada;

  -- limpieza
  delete from venta_pagos where venta_id = v_venta_id;
  delete from venta_items where venta_id = v_venta_id;
  update productos set stock = stock + 1 where id = v_producto_id;
  delete from ventas where id = v_venta_id;
  delete from clientes where id = v_cliente_id;

  raise notice 'OK: venta a crédito con enganche realiza ganancia proporcional correctamente';
end $$;
```

Expected: `NOTICE: OK: ...`, no assertion errors.

---

## Task 3: Rework `registrar_abono()` — reparto FIFO entre ventas a crédito abiertas del cliente

**Files:**
- Supabase (via MCP `apply_migration`) — no local file.

**Interfaces:**
- Consumes: `ventas.saldo_pendiente_venta`, `venta_pagos` (Task 1), ventas ordenadas por `creado_en` (existentes).
- Produces: `registrar_abono(p_cliente_id uuid, p_vendedor_id uuid, p_monto numeric)` — misma firma y shape de retorno (`TABLE(folio text, saldo_restante numeric)`), sin cambios visibles para quien la llama (Task 7 no necesita tocar el frontend de abonos).

- [ ] **Step 1: Apply the new function**

```sql
CREATE OR REPLACE FUNCTION public.registrar_abono(p_cliente_id uuid, p_vendedor_id uuid, p_monto numeric)
 RETURNS TABLE(folio text, saldo_restante numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_folio text;
  v_saldo numeric;
  v_abono_id uuid;
  v_restante numeric;
  v_venta record;
  v_aplicado numeric;
  v_ratio numeric;
  v_utilidad numeric;
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'Monto inválido';
  end if;

  select saldo_pendiente into v_saldo from clientes where id = p_cliente_id for update;
  if not found then
    raise exception 'Cliente no encontrado';
  end if;

  if p_monto > v_saldo then
    raise exception 'MONTO_MAYOR_A_SALDO';
  end if;

  v_folio := generate_folio();

  insert into abonos (folio, cliente_id, vendedor_id, monto)
  values (v_folio, p_cliente_id, p_vendedor_id, p_monto)
  returning id into v_abono_id;

  v_restante := p_monto;

  for v_venta in
    select id, total, costo_total, saldo_pendiente_venta
    from ventas
    where cliente_id = p_cliente_id and tipo = 'credito'
      and anulado = false and saldo_pendiente_venta > 0
    order by creado_en asc
    for update
  loop
    exit when v_restante <= 0;

    v_aplicado := least(v_restante, v_venta.saldo_pendiente_venta);
    v_ratio := (v_venta.total - v_venta.costo_total) / v_venta.total;
    v_utilidad := round(v_aplicado * v_ratio, 2);

    insert into venta_pagos (venta_id, abono_id, monto, utilidad_realizada)
    values (v_venta.id, v_abono_id, v_aplicado, v_utilidad);

    update ventas set saldo_pendiente_venta = saldo_pendiente_venta - v_aplicado
      where id = v_venta.id;

    v_restante := v_restante - v_aplicado;
  end loop;

  update clientes set saldo_pendiente = saldo_pendiente - p_monto where id = p_cliente_id;

  return query select v_folio, (v_saldo - p_monto);
end;
$function$
```

- [ ] **Step 2: Verify — FIFO entre dos ventas de distinto vendedor**

Este es el caso central del diseño: un cliente con dos ventas a crédito de vendedores distintos, y un abono que solo alcanza para pagar la primera — la ganancia debe quedar atribuida a cada vendedor original, no a quien cobra el abono.

```sql
do $$
declare
  v_producto_id uuid;
  v_angie_id uuid;
  v_alexa_id uuid;
  v_papa_id uuid;
  v_cliente_id uuid;
  v_venta1 record;
  v_venta2 record;
  v_venta1_id uuid;
  v_venta2_id uuid;
  v_abono record;
  v_ganancia_angie numeric;
  v_ganancia_alexa numeric;
begin
  select id into v_producto_id from productos where nombre = 'Playera polo azul';
  select id into v_angie_id from usuarios where nombre = 'Angie';
  select id into v_alexa_id from usuarios where nombre = 'Alexa';
  select id into v_papa_id from usuarios where nombre = 'Papá';
  insert into clientes (nombre) values ('TEST_QA_fifo') returning id into v_cliente_id;

  -- Venta 1 (Angie): total 300, costo 150, sin enganche -> saldo_pendiente_venta = 300, margen 50%
  select * into v_venta1 from registrar_venta(
    'credito', v_cliente_id, v_angie_id, 0,
    jsonb_build_array(jsonb_build_object('producto_id', v_producto_id, 'cantidad', 1, 'precio_unitario', 300))
  );
  select id into v_venta1_id from ventas where folio = v_venta1.folio;

  -- Venta 2 (Alexa): total 500, costo 150, sin enganche -> saldo_pendiente_venta = 500, margen 70%
  select * into v_venta2 from registrar_venta(
    'credito', v_cliente_id, v_alexa_id, 0,
    jsonb_build_array(jsonb_build_object('producto_id', v_producto_id, 'cantidad', 1, 'precio_unitario', 500))
  );
  select id into v_venta2_id from ventas where folio = v_venta2.folio;

  -- Papá cobra un abono de 400 (paga toda la venta 1 y una parte de la venta 2), pero la ganancia debe ir a Angie/Alexa, no a Papá
  select * into v_abono from registrar_abono(v_cliente_id, v_papa_id, 400);

  assert (select saldo_pendiente_venta from ventas where id = v_venta1_id) = 0, 'venta 1 debe quedar totalmente pagada';
  assert (select saldo_pendiente_venta from ventas where id = v_venta2_id) = 400, 'venta 2 debe quedar con 400 pendientes (500-100 aplicados)';
  assert (select saldo_pendiente from clientes where id = v_cliente_id) = 400, 'saldo global del cliente esperado 400 (800-400)';

  select coalesce(sum(vp.utilidad_realizada), 0) into v_ganancia_angie
    from venta_pagos vp where vp.venta_id = v_venta1_id;
  select coalesce(sum(vp.utilidad_realizada), 0) into v_ganancia_alexa
    from venta_pagos vp where vp.venta_id = v_venta2_id;

  assert v_ganancia_angie = 150, 'ganancia de la venta de Angie esperada 150 (300*0.5), fue ' || v_ganancia_angie;
  assert v_ganancia_alexa = 70, 'ganancia de la venta de Alexa esperada 70 (100*0.7), fue ' || v_ganancia_alexa;

  -- limpieza
  delete from venta_pagos where venta_id in (v_venta1_id, v_venta2_id);
  delete from venta_items where venta_id in (v_venta1_id, v_venta2_id);
  delete from abonos where cliente_id = v_cliente_id;
  update productos set stock = stock + 2 where id = v_producto_id;
  delete from ventas where id in (v_venta1_id, v_venta2_id);
  delete from clientes where id = v_cliente_id;

  raise notice 'OK: el abono se reparte FIFO y la ganancia se atribuye al vendedor original de cada venta';
end $$;
```

Expected: `NOTICE: OK: ...`, no assertion errors.

---

## Task 4: Rework `anular_abono()` — revierte la asignación FIFO de ese abono

**Files:**
- Supabase (via MCP `apply_migration`) — no local file.

**Interfaces:**
- Consumes: `venta_pagos` rows tied to an `abono_id` (written by Task 3).
- Produces: `anular_abono(p_abono_id uuid, p_usuario_id uuid)` — misma firma y shape de retorno (`TABLE(folio text)`), sin cambios en el frontend (Task 7 no toca esto).

- [ ] **Step 1: Apply the new function**

```sql
CREATE OR REPLACE FUNCTION public.anular_abono(p_abono_id uuid, p_usuario_id uuid)
 RETURNS TABLE(folio text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_folio text;
  v_cliente_id uuid;
  v_vendedor_id uuid;
  v_monto numeric;
  v_anulado boolean;
  v_rol text;
  v_pago record;
begin
  select abonos.folio, abonos.cliente_id, abonos.vendedor_id, abonos.monto, abonos.anulado
    into v_folio, v_cliente_id, v_vendedor_id, v_monto, v_anulado
    from abonos where abonos.id = p_abono_id for update;

  if not found then
    raise exception 'NO_ENCONTRADO';
  end if;

  if v_anulado then
    raise exception 'YA_ANULADO';
  end if;

  select rol into v_rol from usuarios where id = p_usuario_id;
  if v_rol is null then
    raise exception 'NO_ENCONTRADO';
  end if;

  if v_rol <> 'admin' and v_vendedor_id <> p_usuario_id then
    raise exception 'PERMISO_DENEGADO';
  end if;

  for v_pago in select id, venta_id, monto from venta_pagos where abono_id = p_abono_id
  loop
    update ventas set saldo_pendiente_venta = saldo_pendiente_venta + v_pago.monto
      where id = v_pago.venta_id;
    delete from venta_pagos where id = v_pago.id;
  end loop;

  update clientes set saldo_pendiente = saldo_pendiente + v_monto where id = v_cliente_id;

  update abonos set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
    where id = p_abono_id;

  return query select v_folio as folio;
end;
$function$
```

- [ ] **Step 2: Verify — anular abono revierte saldo_pendiente_venta y borra la ganancia realizada**

```sql
do $$
declare
  v_producto_id uuid;
  v_angie_id uuid;
  v_cliente_id uuid;
  v_venta record;
  v_venta_id uuid;
  v_abono record;
  v_abono_id uuid;
begin
  select id into v_producto_id from productos where nombre = 'Playera polo azul';
  select id into v_angie_id from usuarios where nombre = 'Angie';
  insert into clientes (nombre) values ('TEST_QA_anular_abono') returning id into v_cliente_id;

  select * into v_venta from registrar_venta(
    'credito', v_cliente_id, v_angie_id, 0,
    jsonb_build_array(jsonb_build_object('producto_id', v_producto_id, 'cantidad', 1, 'precio_unitario', 300))
  );
  select id into v_venta_id from ventas where folio = v_venta.folio;

  select * into v_abono from registrar_abono(v_cliente_id, v_angie_id, 100);
  select id into v_abono_id from abonos where folio = v_abono.folio;

  assert (select saldo_pendiente_venta from ventas where id = v_venta_id) = 200, 'tras el abono, pendiente esperado 200';
  assert (select count(*) from venta_pagos where abono_id = v_abono_id) = 1, 'debe existir 1 venta_pagos para el abono';

  perform anular_abono(v_abono_id, v_angie_id);

  assert (select saldo_pendiente_venta from ventas where id = v_venta_id) = 300, 'tras anular el abono, pendiente debe regresar a 300';
  assert (select saldo_pendiente from clientes where id = v_cliente_id) = 300, 'saldo del cliente debe regresar a 300';
  assert (select count(*) from venta_pagos where abono_id = v_abono_id) = 0, 'el venta_pagos del abono anulado debe desaparecer';

  -- limpieza (abonos antes que clientes, por el FK abonos_cliente_id_fkey)
  delete from venta_pagos where venta_id = v_venta_id;
  delete from venta_items where venta_id = v_venta_id;
  update productos set stock = stock + 1 where id = v_producto_id;
  delete from ventas where id = v_venta_id;
  delete from abonos where cliente_id = v_cliente_id;
  delete from clientes where id = v_cliente_id;

  raise notice 'OK: anular abono revierte saldo_pendiente_venta y borra la ganancia realizada';
end $$;
```

Expected: `NOTICE: OK: ...`, no assertion errors.

---

## Task 5: Rework `anular_venta()` — rama crédito ya no bloquea, descuenta solo lo pendiente de esa venta

**Files:**
- Supabase (via MCP `apply_migration`) — no local file.
- Modify: `app.js:1166-1210` (`confirmarAnular()`, in the Historial section — the frontend error-message mapping for the code this task removes)

**Interfaces:**
- Consumes: `ventas.saldo_pendiente_venta` (Task 1/2).
- Produces: `anular_venta(p_venta_id uuid, p_usuario_id uuid)` — misma firma y shape de retorno (`TABLE(folio text)`). **Comportamiento cambia**: ya no puede lanzar `SALDO_INSUFICIENTE_PARA_ANULAR` — ese código de error nunca vuelve a ocurrir, así que el `else if` que lo mapea en `confirmarAnular()` (Historial) queda muerto y se elimina en el Step 3 de esta tarea.

- [ ] **Step 1: Apply the new function**

```sql
CREATE OR REPLACE FUNCTION public.anular_venta(p_venta_id uuid, p_usuario_id uuid)
 RETURNS TABLE(folio text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_folio text;
  v_tipo text;
  v_cliente_id uuid;
  v_vendedor_id uuid;
  v_anulado boolean;
  v_rol text;
  v_saldo_pendiente_venta numeric;
  v_item record;
begin
  select public.ventas.folio, public.ventas.tipo, public.ventas.cliente_id, public.ventas.vendedor_id,
         public.ventas.anulado, public.ventas.saldo_pendiente_venta
    into v_folio, v_tipo, v_cliente_id, v_vendedor_id, v_anulado, v_saldo_pendiente_venta
    from public.ventas where public.ventas.id = p_venta_id for update;

  if not found then
    raise exception 'NO_ENCONTRADO';
  end if;

  if v_anulado then
    raise exception 'YA_ANULADO';
  end if;

  select public.usuarios.rol into v_rol from public.usuarios where public.usuarios.id = p_usuario_id;
  if v_rol is null then
    raise exception 'NO_ENCONTRADO';
  end if;

  if v_rol <> 'admin' and v_vendedor_id <> p_usuario_id then
    raise exception 'PERMISO_DENEGADO';
  end if;

  for v_item in select public.venta_items.producto_id, public.venta_items.cantidad from public.venta_items where public.venta_items.venta_id = p_venta_id
  loop
    update public.productos set stock = stock + v_item.cantidad where public.productos.id = v_item.producto_id;
  end loop;

  -- Ya no se bloquea si el cliente "abonó de más": solo se descuenta lo que le quedaba
  -- pendiente a ESTA venta específica (siempre <= saldo global por invariante), nunca puede
  -- dejarlo en negativo. Lo ya cobrado/realizado vía venta_pagos no se toca (ver diseño sección 1.7).
  if v_tipo = 'credito' and v_saldo_pendiente_venta > 0 then
    update public.clientes set saldo_pendiente = saldo_pendiente - v_saldo_pendiente_venta
      where public.clientes.id = v_cliente_id;
    update public.ventas set saldo_pendiente_venta = 0 where public.ventas.id = p_venta_id;
  end if;

  update public.ventas set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
    where public.ventas.id = p_venta_id;

  return query select v_folio;
end;
$function$
```

- [ ] **Step 2: Verify — anular venta con abonos ya aplicados ya no bloquea**

Reproduce exactamente el caso que antes lanzaba `SALDO_INSUFICIENTE_PARA_ANULAR`: una venta a crédito ya parcialmente pagada.

```sql
do $$
declare
  v_producto_id uuid;
  v_angie_id uuid;
  v_cliente_id uuid;
  v_venta record;
  v_venta_id uuid;
  v_abono record;
  v_stock_inicial int;
begin
  select id into v_producto_id from productos where nombre = 'Playera polo azul';
  select stock into v_stock_inicial from productos where id = v_producto_id;
  select id into v_angie_id from usuarios where nombre = 'Angie';
  insert into clientes (nombre) values ('TEST_QA_anular_venta') returning id into v_cliente_id;

  select * into v_venta from registrar_venta(
    'credito', v_cliente_id, v_angie_id, 0,
    jsonb_build_array(jsonb_build_object('producto_id', v_producto_id, 'cantidad', 1, 'precio_unitario', 300))
  );
  select id into v_venta_id from ventas where folio = v_venta.folio;

  assert (select stock from productos where id = v_producto_id) = v_stock_inicial - 1, 'stock debe bajar 1 tras la venta';

  -- el cliente ya pagó 250 de los 300
  select * into v_abono from registrar_abono(v_cliente_id, v_angie_id, 250);
  assert (select saldo_pendiente_venta from ventas where id = v_venta_id) = 50, 'pendiente esperado 50 antes de anular';

  -- anular ya no debe lanzar SALDO_INSUFICIENTE_PARA_ANULAR
  perform anular_venta(v_venta_id, v_angie_id);

  assert (select anulado from ventas where id = v_venta_id) = true, 'la venta debe quedar anulada';
  assert (select saldo_pendiente from clientes where id = v_cliente_id) = 0, 'saldo del cliente debe bajar solo los 50 pendientes (no revierte los 250 ya cobrados)';
  assert (select count(*) from venta_pagos where venta_id = v_venta_id) = 1, 'el venta_pagos del abono ya cobrado debe seguir existiendo (ganancia ya realizada no se revierte)';
  -- anular_venta ya repuso el stock automáticamente (efecto propio de la función) -> debe quedar de vuelta en el valor inicial
  assert (select stock from productos where id = v_producto_id) = v_stock_inicial, 'stock debe quedar igual al inicial tras anular (la función ya lo repuso)';

  -- limpieza — el stock YA quedó en su valor original por el anular_venta de arriba, no se debe volver a tocar
  delete from venta_pagos where venta_id = v_venta_id;
  delete from venta_items where venta_id = v_venta_id;
  delete from abonos where cliente_id = v_cliente_id;
  delete from ventas where id = v_venta_id;
  delete from clientes where id = v_cliente_id;

  raise notice 'OK: anular venta a crédito con abonos aplicados ya no bloquea, y no revierte lo ya realizado';
end $$;
```

Expected: `NOTICE: OK: ...`, no assertion errors. Note there is **no manual stock adjustment in the cleanup** — `anular_venta` already reposed the 1 unit as its own real effect (create −1, anular +1 nets to zero), so touching stock again in cleanup would incorrectly leave real inventory at −1.

- [ ] **Step 3: Remove the now-dead `SALDO_INSUFICIENTE_PARA_ANULAR` error mapping in the frontend**

In `confirmarAnular()` (`app.js:1187-1199`), that error code can no longer be raised by `anular_venta()`, so remove its branch:

```js
if (error) {
  const msg = error.message || '';
  if (msg.includes('PERMISO_DENEGADO')) {
    toast('No tienes permiso para anular este registro.', 'error');
  } else if (msg.includes('YA_ANULADO')) {
    toast('Este registro ya estaba anulado.', 'error');
  } else {
    toast('No se pudo anular. Intenta de nuevo.', 'error');
  }
  return;
}
```

- [ ] **Step 4: Confirm no stray test rows remain**

```sql
select
  (select count(*) from clientes where nombre like 'TEST_QA_%') as clientes_test_restantes,
  (select count(*) from productos where nombre like 'TEST_QA_%') as productos_test_restantes,
  (select stock from productos where nombre = 'Playera polo azul') as stock_final;
```

Expected: both `_restantes` columns = `0` (all test rows cleaned up), and `stock_final = 41` (the same as before Task 2 started — confirms no test venta permanently consumed real stock). If `productos_test_restantes` is not 0, delete the leftover row from Task 1 Step 3 (`TEST_QA_costo0`) — that insert was expected to fail and never persist, but confirm it here.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
Ticket 11: anular venta a crédito ya no bloquea por saldo insuficiente

anular_venta() descuenta ahora solo el saldo pendiente propio de esa
venta (nunca puede quedar negativo), en vez de bloquear cuando el
cliente ya había abonado contra ella. Quita el mapeo de error ahora
muerto (SALDO_INSUFICIENTE_PARA_ANULAR) en el historial.
EOF
)"
```

---

## Task 6: Inventario — campo Costo obligatorio + ocultar costo con botón de mostrar

**Files:**
- Modify: `index.html:161-191` (producto-sheet form)
- Modify: `app.js:314-502` (Inventario section)
- Modify: `styles.css` (append new rules)

**Interfaces:**
- Consumes: `productos.costo` (Task 1).
- Produces: `loadProductos()` now selects `costo`; `productosCache` entries carry `.costo`. Task 7 does not depend on this (Inventario and Carrito are independent UI surfaces), but both reuse the same visual pattern (masked text + toggle button).

- [ ] **Step 1: Add the Costo field to the product form**

In `index.html`, relabel the existing Precio field and add a new Costo field right after it:

```html
<div class="field">
  <label for="producto-precio">Precio sugerido (MXN)</label>
  <input id="producto-precio" type="number" step="0.01" min="0" placeholder="0.00" />
</div>
<div class="field">
  <label for="producto-costo">Costo (MXN)</label>
  <input id="producto-costo" type="number" step="0.01" min="0" placeholder="0.00" />
</div>
```

(Replaces the single existing `producto-precio` field block at `index.html:168-171`.)

- [ ] **Step 2: Load/save the Costo field in `app.js`**

In `loadProductos()` (`app.js:325-339`), add `costo` to the select:

```js
async function loadProductos() {
  const { data, error } = await supabase
    .from('productos')
    .select('id, nombre, precio, costo, foto_url, stock, categoria')
    .order('nombre');
  // ...unchanged below
```

In `openProductoForm()` (`app.js:393-414`), load the field when editing:

```js
document.getElementById('producto-costo').value = producto ? producto.costo : '';
```

(Insert right after the existing `producto-precio` line.)

In `saveProducto()` (`app.js:428-495`), read, validate, and send `costo`:

```js
const precio = parseFloat(document.getElementById('producto-precio').value);
const costo = parseFloat(document.getElementById('producto-costo').value);
```

Add validation right after the existing precio check:

```js
if (!Number.isFinite(costo) || costo <= 0) {
  errorEl.textContent = 'El costo es obligatorio y debe ser mayor a $0.';
  return;
}
```

Add `costo` to the payload:

```js
const payload = { nombre, precio, costo, stock, categoria: categoria || null, foto_url: fotoUrl };
```

- [ ] **Step 3: Show cost hidden-by-default with a reveal toggle in the product grid**

Replace the card template in `renderProductosGrid()` (`app.js:376-390`):

```js
productos.forEach((p) => {
  const card = document.createElement('div');
  card.className = 'product-card';
  card.innerHTML = `
    <div class="product-photo" style="background-image:url('${escapeAttr(p.foto_url)}')"></div>
    <div class="product-info">
      <div class="li-title">${escapeHtml(p.nombre)}</div>
      ${p.categoria ? `<div class="li-sub">${escapeHtml(p.categoria)}</div>` : ''}
      <div class="product-stock">Stock: ${Number(p.stock)}</div>
      <div class="product-precio">${money.format(Number(p.precio))}</div>
      <div class="product-costo-row">
        <span class="product-costo oculto">Costo: ••••</span>
        <button type="button" class="costo-toggle-btn" aria-label="Mostrar costo">👁</button>
      </div>
    </div>
  `;
  const costoEl = card.querySelector('.product-costo');
  card.querySelector('.costo-toggle-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const oculto = costoEl.classList.toggle('oculto');
    costoEl.textContent = oculto ? 'Costo: ••••' : `Costo: ${money.format(Number(p.costo))}`;
  });
  card.addEventListener('click', () => openProductoForm(p));
  grid.appendChild(card);
});
```

- [ ] **Step 4: Add CSS for the cost row/toggle**

Append to `styles.css`:

```css
/* ---------- Costo oculto (Inventario y Carrito de venta) ---------- */

.product-costo-row,
.costo-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.product-costo,
.costo-valor {
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}

.costo-toggle-btn {
  background: none;
  border: none;
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
```

- [ ] **Step 5: Manual browser verification**

Start the dev server preview (`preview_start` with a static server, or open `index.html` directly if the project has no dev server config) and in the browser:
1. Open Inventario, tap the existing product — confirm "Costo" field shows `150`.
2. Confirm the grid card shows "Costo: ••••" with an eye button; tap it → shows `$150.00`; tap again → hides.
3. Try saving a new product with no Costo → blocked with the new error message.
4. Save an edit with Costo `175` → reload Inventario → confirm it persisted (tap eye icon shows `$175.00`).

- [ ] **Step 6: Commit**

```bash
git add index.html app.js styles.css
git commit -m "$(cat <<'EOF'
Ticket 11: Inventario — costo obligatorio, oculto por default

Agrega el campo Costo (obligatorio) al alta/edición de productos y lo
muestra oculto en la lista con un botón para revelarlo temporalmente,
para que un cliente no lo vea por descuido en el celular del vendedor.
EOF
)"
```

---

## Task 7: Carrito de venta — precio editable por línea + costo oculto + envío del nuevo payload

**Files:**
- Modify: `index.html:193-251` (venta-panel — no structural change needed, only what `app.js` injects into `#venta-carrito-list`)
- Modify: `app.js:578-874` (Ventas section)
- Modify: `styles.css` (append new rules)

**Interfaces:**
- Consumes: `registrar_venta()`'s new `p_items` shape from Task 2 (`{producto_id, cantidad, precio_unitario}`); `productos.costo` (Task 1).
- Produces: `ventaCarrito` Map value shape changes from `{producto, cantidad}` to `{producto, cantidad, precioUnitario}` — internal to this task, no other task reads it.

- [ ] **Step 1: Fetch `costo` alongside the rest of the product catalog**

In `openVentaPanel()` (`app.js:608-609`), add `costo` to the select:

```js
const [{ data: productos, error: prodError }, { data: clientes, error: cliError }] = await Promise.all([
  supabase.from('productos').select('id, nombre, precio, stock, costo').order('nombre'),
  supabase.from('clientes').select('id, nombre').order('nombre'),
]);
```

- [ ] **Step 2: Carry an editable `precioUnitario` per cart line**

Replace `addToCarrito()` (`app.js:667-676`):

```js
function addToCarrito(producto) {
  const actual = cantidadEnCarrito(producto.id);
  if (actual + 1 > producto.stock) {
    toast('No hay suficiente stock de este producto.', 'error');
    return;
  }
  const existente = ventaCarrito.get(producto.id);
  const precioUnitario = existente ? existente.precioUnitario : Number(producto.precio);
  ventaCarrito.set(producto.id, { producto, cantidad: actual + 1, precioUnitario });
  renderVentaProductos();
  renderVentaCarrito();
}
```

- [ ] **Step 3: Render editable price input + hidden cost per cart line**

Replace `renderVentaCarrito()` (`app.js:690-726`) with a version that (a) uses `precioUnitario` instead of `producto.precio` for the subtotal/total, (b) renders a price input per line, (c) renders the cost toggle, and (d) updates totals without a full re-render on every keystroke (a full re-render would drop input focus mid-typing):

```js
function calcularTotalCarrito() {
  return [...ventaCarrito.values()].reduce((sum, { cantidad, precioUnitario }) => sum + precioUnitario * cantidad, 0);
}

function actualizarTotalCarritoUI() {
  document.getElementById('venta-total').textContent = money.format(calcularTotalCarrito());
}

function renderVentaCarrito() {
  const list = document.getElementById('venta-carrito-list');
  const vacio = document.getElementById('venta-carrito-vacio');
  list.innerHTML = '';
  vacio.style.display = ventaCarrito.size === 0 ? 'block' : 'none';

  ventaCarrito.forEach(({ producto, cantidad, precioUnitario }, productoId) => {
    const item = document.createElement('div');
    item.className = 'list-item carrito-item';
    item.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(producto.nombre)}</div>
        <div class="costo-row">
          <span class="costo-valor oculto">Costo: ••••</span>
          <button type="button" class="costo-toggle-btn" aria-label="Mostrar costo">👁</button>
        </div>
        <div class="carrito-precio-row">
          <label>Precio de venta</label>
          <input type="number" step="0.01" min="0.01" class="carrito-precio-input" value="${precioUnitario}" />
        </div>
        <div class="li-sub carrito-subtotal">${cantidad} × ${money.format(precioUnitario)} = ${money.format(precioUnitario * cantidad)}</div>
      </div>
      <div class="qty-controls">
        <button type="button" class="qty-btn" data-action="menos">−</button>
        <button type="button" class="qty-btn" data-action="mas">+</button>
      </div>
    `;

    const costoEl = item.querySelector('.costo-valor');
    item.querySelector('.costo-toggle-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const oculto = costoEl.classList.toggle('oculto');
      costoEl.textContent = oculto ? 'Costo: ••••' : `Costo: ${money.format(Number(producto.costo))}`;
    });

    item.querySelector('.carrito-precio-input').addEventListener('input', (e) => {
      const nuevoPrecio = parseFloat(e.target.value);
      const entry = ventaCarrito.get(productoId);
      if (!entry) return;
      entry.precioUnitario = Number.isFinite(nuevoPrecio) && nuevoPrecio > 0 ? nuevoPrecio : entry.precioUnitario;
      item.querySelector('.carrito-subtotal').textContent =
        `${entry.cantidad} × ${money.format(entry.precioUnitario)} = ${money.format(entry.precioUnitario * entry.cantidad)}`;
      actualizarTotalCarritoUI();
    });

    item.querySelector('[data-action="menos"]').addEventListener('click', (e) => {
      e.stopPropagation();
      decrementarCarrito(producto.id);
    });
    item.querySelector('[data-action="mas"]').addEventListener('click', (e) => {
      e.stopPropagation();
      addToCarrito(producto);
    });
    list.appendChild(item);
  });

  actualizarTotalCarritoUI();
}
```

- [ ] **Step 4: Send `precio_unitario` per item and use edited prices for the total/receipt**

In `confirmarVenta()` (`app.js:728-822`), replace the total calculation, items payload, and receipt items:

```js
const totalCarrito = calcularTotalCarrito();
```

(Replaces the `.reduce(...)` block at `app.js:751-752`.)

```js
const items = [...ventaCarrito.values()].map(({ producto, cantidad, precioUnitario }) => ({
  producto_id: producto.id,
  cantidad,
  precio_unitario: precioUnitario,
}));
const itemsParaRecibo = [...ventaCarrito.values()];
```

(Replaces `app.js:764-768`.)

- [ ] **Step 5: Fix the receipt to show the actual sold price, not the catalog price**

In `mostrarReciboVenta()` (`app.js:824-858`), the line generator currently reads `producto.precio`. Replace it to use the edited `precioUnitario` carried by each cart entry:

```js
const lineasProductos = info.items
  .map(({ producto, cantidad, precioUnitario }) => `
    <div class="recibo-linea">
      <span>${cantidad} × ${escapeHtml(producto.nombre)}</span>
      <span>${money.format(precioUnitario * cantidad)}</span>
    </div>
  `)
  .join('');
```

- [ ] **Step 6: Add CSS for the price input**

Append to `styles.css`:

```css
.carrito-precio-row {
  margin: 6px 0;
}

.carrito-precio-row label {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
}

.carrito-precio-input {
  width: 110px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  font-size: 14px;
}
```

- [ ] **Step 7: Manual browser verification**

In the browser (Inventario product must already have Costo set from Task 6):
1. Open "Nueva venta", add the product to the cart — confirm the price input is pre-filled with the catalog's precio sugerido.
2. Edit the price input to a different value — confirm the subtotal line and the "Total" footer update live, and the input never loses focus while typing.
3. Tap the cost eye icon on the cart line — confirm it reveals/hides `$150.00` (or whatever Costo you set).
4. Confirm a contado sale with the edited price — confirm the on-screen receipt shows the edited price (not the catalog price), and the total matches.
5. Confirm a crédito sale with an enganche — confirm the receipt's enganche/saldo math still works using the edited price as the sale total.
6. Check the Supabase `ventas`/`venta_items` rows for that sale via the MCP `execute_sql` tool — confirm `precio_unitario` matches what you typed and `costo_unitario`/`costo_total` are populated.

- [ ] **Step 8: Commit**

```bash
git add index.html app.js styles.css
git commit -m "$(cat <<'EOF'
Ticket 11: Carrito de venta — precio editable por línea, costo oculto

El vendedor puede ajustar el precio de cada línea antes de confirmar
(el precio sugerido del producto solo precarga el campo). El costo del
producto aparece oculto por default con botón para revelarlo, igual
que en Inventario.
EOF
)"
```

---

## Task 8: Reportes — selector de mes, totales, saldo, tabla por vendedor, detalle por artículo

**Files:**
- Modify: `index.html:111-114` (replace the `tab-reportes` placeholder)
- Modify: `app.js` (new "Reportes" section + `switchTab`/`init` wiring)
- Modify: `styles.css` (append new rules)

**Interfaces:**
- Consumes: `ventas`, `abonos`, `venta_items`, `venta_pagos`, `clientes` tables (all from Tasks 1–5).
- Produces: `loadReportes()`, `cambiarMesReportes(delta)`, `initReportes()` — called from `switchTab('reportes')` and `init()` respectively, same wiring pattern as `loadClientes`/`loadProductos`/`loadDashboard`.

- [ ] **Step 1: Replace the Reportes tab placeholder markup**

Replace `index.html:111-114`:

```html
<!-- Reportes -->
<div id="tab-reportes" class="tab-panel">
  <div class="reportes-mes-selector">
    <button id="reportes-mes-anterior" class="icon-btn-alt" type="button" aria-label="Mes anterior">‹</button>
    <span id="reportes-mes-label">—</span>
    <button id="reportes-mes-siguiente" class="icon-btn-alt" type="button" aria-label="Mes siguiente">›</button>
  </div>

  <div class="dash-stats-row">
    <div class="dash-stat-card">
      <div class="dash-stat-label">Vendido en el periodo</div>
      <div class="dash-stat-value" id="rep-total-vendido">$0.00</div>
      <div class="dash-stat-sub" id="rep-total-ventas-count">0 ventas</div>
    </div>
    <div class="dash-stat-card dash-stat-alt">
      <div class="dash-stat-label">Ganancia neta del periodo</div>
      <div class="dash-stat-value" id="rep-ganancia-total">$0.00</div>
    </div>
  </div>

  <h3 class="fs-subtitle">Saldo pendiente del negocio (a hoy)</h3>
  <div class="reportes-saldo-total" id="rep-saldo-total">$0.00</div>
  <div id="rep-clientes-saldo-list" class="list"></div>
  <p id="rep-clientes-saldo-empty" class="tab-placeholder" style="display:none;">
    Ningún cliente tiene saldo pendiente.
  </p>

  <h3 class="fs-subtitle">Por vendedor (periodo seleccionado)</h3>
  <div class="reportes-table-wrap">
    <table class="reportes-table">
      <thead>
        <tr><th>Vendedor</th><th>Vendido</th><th>Abonado</th><th>Ganancia neta</th></tr>
      </thead>
      <tbody id="rep-vendedores-tbody"></tbody>
    </table>
  </div>

  <h3 class="fs-subtitle">Detalle artículo por artículo (periodo seleccionado)</h3>
  <div class="reportes-table-wrap">
    <table class="reportes-table">
      <thead>
        <tr><th>Fecha</th><th>Folio</th><th>Producto</th><th>Cant.</th><th>Costo unit.</th><th>Precio unit.</th><th>% util.</th><th>Vendedor</th></tr>
      </thead>
      <tbody id="rep-detalle-tbody"></tbody>
    </table>
  </div>
  <p id="rep-detalle-empty" class="tab-placeholder" style="display:none;">
    No hay ventas registradas en este periodo.
  </p>
</div>
```

- [ ] **Step 2: Add the Reportes section to `app.js`**

Append a new section right before `// ---------- Init ----------` (`app.js:1217`):

```js
// ---------- Reportes ----------

const VENDEDORES_FIJOS = ['Papá', 'Angie', 'Alexa', 'Alexis'];
const mesFmt = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });
const fechaCortaFmt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'short' });

let reportesMes = (() => {
  const hoy = new Date();
  return new Date(hoy.getFullYear(), hoy.getMonth(), 1);
})();

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function rangoMesReportes() {
  const inicio = reportesMes;
  const fin = new Date(inicio.getFullYear(), inicio.getMonth() + 1, 1);
  return { inicio, fin };
}

function cambiarMesReportes(delta) {
  reportesMes = new Date(reportesMes.getFullYear(), reportesMes.getMonth() + delta, 1);
  loadReportes();
}

async function loadReportes() {
  const { inicio, fin } = rangoMesReportes();
  const inicioISO = inicio.toISOString();
  const finISO = fin.toISOString();

  document.getElementById('reportes-mes-label').textContent = capitalize(mesFmt.format(inicio));

  const [
    { data: ventasPeriodo, error: ventasError },
    { data: abonosPeriodo, error: abonosError },
    { data: clientesSaldo, error: clientesError },
    { data: pagosPeriodo, error: pagosError },
    { data: itemsPeriodo, error: itemsError },
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
  ]);

  if (ventasError || abonosError || clientesError || pagosError || itemsError) {
    toast('No se pudo cargar Reportes.', 'error');
    return;
  }

  renderReportesTotales(ventasPeriodo || [], pagosPeriodo || []);
  renderReportesSaldos(clientesSaldo || []);
  renderReportesVendedores(ventasPeriodo || [], abonosPeriodo || [], pagosPeriodo || []);
  renderReportesDetalle(itemsPeriodo || []);
}

function renderReportesTotales(ventas, pagos) {
  const totalVendido = ventas.reduce((sum, v) => sum + Number(v.total), 0);
  const gananciaTotal = pagos.reduce((sum, p) => sum + Number(p.utilidad_realizada), 0);

  document.getElementById('rep-total-vendido').textContent = money.format(totalVendido);
  document.getElementById('rep-total-ventas-count').textContent =
    `${ventas.length} venta${ventas.length === 1 ? '' : 's'}`;
  document.getElementById('rep-ganancia-total').textContent = money.format(gananciaTotal);
}

function renderReportesSaldos(clientes) {
  const total = clientes.reduce((sum, c) => sum + Number(c.saldo_pendiente), 0);
  document.getElementById('rep-saldo-total').textContent = money.format(total);

  const list = document.getElementById('rep-clientes-saldo-list');
  const empty = document.getElementById('rep-clientes-saldo-empty');
  list.innerHTML = '';
  empty.style.display = clientes.length === 0 ? 'block' : 'none';

  clientes.forEach((cliente) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main"><div class="li-title">${escapeHtml(cliente.nombre)}</div></div>
      <div class="li-badge pendiente">${money.format(Number(cliente.saldo_pendiente))}</div>
    `;
    list.appendChild(item);
  });
}

function renderReportesVendedores(ventas, abonos, pagos) {
  const tbody = document.getElementById('rep-vendedores-tbody');
  tbody.innerHTML = '';

  VENDEDORES_FIJOS.forEach((nombre) => {
    const vendido = ventas
      .filter((v) => v.vendedor && v.vendedor.nombre === nombre)
      .reduce((sum, v) => sum + Number(v.total), 0);
    const abonado = abonos
      .filter((a) => a.vendedor && a.vendedor.nombre === nombre)
      .reduce((sum, a) => sum + Number(a.monto), 0);
    const ganancia = pagos
      .filter((p) => p.venta && p.venta.vendedor && p.venta.vendedor.nombre === nombre)
      .reduce((sum, p) => sum + Number(p.utilidad_realizada), 0);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(nombre)}</td>
      <td>${money.format(vendido)}</td>
      <td>${money.format(abonado)}</td>
      <td>${money.format(ganancia)}</td>
    `;
    tbody.appendChild(row);
  });
}

function renderReportesDetalle(items) {
  const tbody = document.getElementById('rep-detalle-tbody');
  const empty = document.getElementById('rep-detalle-empty');
  tbody.innerHTML = '';
  empty.style.display = items.length === 0 ? 'block' : 'none';

  items.forEach((item) => {
    const costo = Number(item.costo_unitario);
    const precio = Number(item.precio_unitario);
    const utilidadPct = precio > 0 ? ((precio - costo) / precio) * 100 : 0;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${fechaCortaFmt.format(new Date(item.venta.creado_en))}</td>
      <td>${escapeHtml(item.venta.folio)}</td>
      <td>${escapeHtml(item.producto ? item.producto.nombre : '—')}</td>
      <td>${item.cantidad}</td>
      <td>${money.format(costo)}</td>
      <td>${money.format(precio)}</td>
      <td>${utilidadPct.toFixed(1)}%</td>
      <td>${escapeHtml(item.venta.vendedor ? item.venta.vendedor.nombre : '—')}</td>
    `;
    tbody.appendChild(row);
  });
}

function initReportes() {
  document.getElementById('reportes-mes-anterior').addEventListener('click', () => cambiarMesReportes(-1));
  document.getElementById('reportes-mes-siguiente').addEventListener('click', () => cambiarMesReportes(1));
}
```

- [ ] **Step 3: Wire up tab switching and init**

In `switchTab()` (`app.js:115-129`), add the Reportes load call:

```js
if (tabName === 'clientes') loadClientes();
if (tabName === 'inventario') loadProductos();
if (tabName === 'inicio') loadDashboard();
if (tabName === 'reportes') loadReportes();
```

In `init()` (`app.js:1219-1239`), register the new init function:

```js
initNav();
initClientes();
initInventario();
initVentas();
initAbonos();
initHistorial();
initReportes();
```

- [ ] **Step 4: Add CSS for the month selector and tables**

Append to `styles.css`:

```css
/* ---------- Reportes ---------- */

.reportes-mes-selector {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-bottom: 16px;
  font-weight: 700;
  color: var(--navy);
}

.icon-btn-alt {
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--navy);
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-size: 18px;
  cursor: pointer;
}

.reportes-saldo-total {
  font-size: 20px;
  font-weight: 700;
  color: var(--error);
  margin: 4px 0 14px;
}

.reportes-table-wrap {
  overflow-x: auto;
  margin-bottom: 8px;
  -webkit-overflow-scrolling: touch;
}

.reportes-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border-radius: 12px;
  overflow: hidden;
  font-size: 13px;
}

.reportes-table th,
.reportes-table td {
  padding: 10px 12px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}

.reportes-table th {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.reportes-table tbody tr:last-child td {
  border-bottom: none;
}
```

- [ ] **Step 5: Manual browser verification**

In the browser, using the sale(s) confirmed in Task 7 Step 7 as real data:
1. Open Reportes — confirm the month label shows the current month and matches today's sales.
2. Confirm "Vendido en el periodo" and "Ganancia neta del periodo" show non-zero values matching what you sold in Task 7.
3. Confirm "Saldo pendiente del negocio" and the client list match the Clientes tab.
4. Confirm the per-vendor table shows all 4 fixed names (Papá/Angie/Alexa/Alexis), even ones with $0 activity.
5. Confirm the item detail table shows the line(s) from Task 7's sale with the right costo/precio/% de utilidad, and the cost is **not** masked here (unlike Inventario/Carrito).
6. Tap ‹ to go to the previous month — confirm everything recalculates (should show mostly zeros unless there's older data) and tap › to come back.
7. Open the browser's Network tab (or `read_network_requests`) and confirm the 5 Reportes requests return 200 with no PostgREST embedding errors — this is the step most likely to surface a nested-select syntax mistake.

- [ ] **Step 6: Commit**

```bash
git add index.html app.js styles.css
git commit -m "$(cat <<'EOF'
Ticket 11: Reportes — totales, saldo, ganancia por vendedor, detalle

Construye la pestaña Reportes completa: selector de mes, total vendido
y ganancia neta del periodo, saldo pendiente del negocio, tabla por
vendedor (vendido/abonado/ganancia) y detalle artículo por artículo
con costo, precio y % de utilidad sin ocultar.
EOF
)"
```

---

## Task 9: Cierre — bump de caché, TICKETS.md, verificación final

**Files:**
- Modify: `sw.js:1`
- Modify: `TICKETS.md` (ticket 11 section)

**Interfaces:** None — this task only closes out bookkeeping and does a final regression pass.

- [ ] **Step 1: Bump the service worker cache version**

In `sw.js:1`, since `app.js` and `styles.css` changed across Tasks 6–8:

```js
const CACHE = 'vf-v4';
```

- [ ] **Step 2: Update TICKETS.md**

Replace the ticket 11 section (currently unchecked placeholder items) with a completed writeup, following the same style as tickets 08/09/10:

```markdown
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
realizada.

- [x] Total vendido (contado + crédito) por período
- [x] Saldo total pendiente del negocio (suma de saldos de todos los clientes)
- [x] Listado de clientes con saldo pendiente, de mayor a menor
- [x] Ventas y abonos agrupados por vendedor (visible para todos)
- [x] Ganancia neta por vendedor, realizada solo sobre lo efectivamente cobrado
- [x] Solo tablas/texto — sin gráficas
```

- [ ] **Step 3: Full regression pass in the browser**

Beyond the per-task checks already done, specifically re-verify the two existing tickets whose SQL functions changed:
1. Ticket 05/06 (venta): confirm a contado sale and a crédito sale both still work end-to-end with the new editable price (already covered in Task 7, but re-check with a second product if you added one).
2. Ticket 07 (abono): confirm registering a normal abono (single open credit sale, no FIFO edge case) still shows the correct `saldo_restante` on the receipt.
3. Ticket 08 (anulación): confirm anular still works for a contado sale (stock reposition) and for a credit sale with **no** abonos yet applied (simplest case) — not just the FIFO edge case already tested in Task 5's SQL verification.
4. Ticket 10 (dashboard): confirm "Ventas de hoy"/"Abonos de hoy" and "Clientes con saldo pendiente" still match reality after all the test data cleanup in Tasks 2–5 (should show only real data, no `TEST_QA_*` leftovers).

- [ ] **Step 4: Commit**

```bash
git add sw.js TICKETS.md
git commit -m "$(cat <<'EOF'
Ticket 11: cierre — bump de caché y actualizar TICKETS.md
EOF
)"
```

- [ ] **Step 5: Push**

Ask the user for explicit confirmation before pushing (per project convention — Vercel auto-deploys on push to `main`, this affects the live app):

```bash
git push
```
