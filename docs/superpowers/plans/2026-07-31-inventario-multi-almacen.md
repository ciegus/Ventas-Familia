# Ticket 13 — Inventario multi-almacén — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar `productos.stock` (un solo número global) por stock distribuido en
almacenes — un almacén "Central" y uno propio por cada usuario (incluido el admin) — con
trazabilidad completa de toda entrada y traspaso, para que una venta siempre descuente del
almacén del vendedor que la hace, no de un total del negocio.

**Architecture:** Tres tablas nuevas en Supabase (`almacenes`, `stock_almacen`,
`movimientos_almacen`) más cuatro funciones SQL `SECURITY DEFINER` nuevas
(`crear_producto`, `registrar_entrada`, `registrar_traspaso`, `anular_movimiento`), el
rework de tres funciones ya existentes (`registrar_venta`, `anular_venta`, `crear_usuario`)
para que lean/escriban `stock_almacen` en vez de `productos.stock`/crear el almacén del
usuario, y tres piezas de frontend nuevas: sección de solo lectura "Stock por almacén" +
botón "Registrar entrada" en Inventario, el carrito de venta filtrado al almacén propio del
vendedor logueado, y una pantalla nueva "📦 Movimientos" (acceso rápido en Inicio).

**Tech Stack:** HTML/CSS/JS vanilla (sin build step, `<script type="module">`), Supabase JS
v2 (`@supabase/supabase-js`), Postgres/plpgsql en Supabase (proyecto `ventas-familia`, ref
`wiewxgkiefsjeonirsid`).

## Global Constraints

- **Este ticket depende del 12 (ya completado):** cada usuario ya existe en `usuarios` con
  `activo` y `crear_usuario()` ya existe — este plan lo extiende, no lo repite.
- **⚠️ Esta sesión no tiene el conector MCP de Supabase conectado** (a diferencia de cuando
  se ejecutó el ticket 12, que sí tenía `apply_migration`/`execute_sql`/`list_tables`
  disponibles como herramientas). **Antes de empezar la Task 1**, quien ejecute este plan
  debe confirmar que tiene esas herramientas disponibles en su sesión — o, si no las tiene,
  aplicar cada bloque SQL de este plan manualmente en el SQL Editor de Supabase
  (`https://supabase.com/dashboard/project/wiewxgkiefsjeonirsid/sql/new`) y usar `select`
  directo ahí mismo para los pasos de verificación. No hay archivo `.sql` local — el
  proyecto no versiona migraciones en el repo (mismo patrón que tickets anteriores).
- **Nunca se borra un almacén, movimiento o fila de `stock_almacen`** — un movimiento se
  anula (`anulado = true` + `anulado_por` + `anulado_en`), nunca se borra la fila.
- **Solo admin registra entradas, traspasos y anulaciones de movimiento** — validado
  server-side en cada función (`PERMISO_DENEGADO`), no solo en el frontend.
- **Anular un movimiento se bloquea (no hay "parcial")** si el almacén destino ya no tiene
  suficiente cantidad para revertirlo — a diferencia de `anular_venta()` (que sí permite
  reponer solo lo que queda pendiente), aquí son unidades físicas reales, no dinero.
- **Mercancía nueva siempre entra primero a Central** — no existe "entrada directa" a un
  almacén de vendedor; de Central se traspasa.
- **Una venta siempre descuenta del almacén propio de quien vende** — el carrito nunca deja
  elegir otro almacén; se resuelve automáticamente de `session.almacenId`.
- **Todos los usuarios ven el historial completo de movimientos** (transparencia,
  consistente con "todos ven todo" — SPEC sección 1); solo admin ve los controles para
  crear/anular.
- Ninguna operación de escritura debe fallar en silencio ni encolarse sin conexión — usar
  `assertOnline()` antes de cualquier RPC de escritura (patrón ya establecido en `app.js`).
- No se agregan dependencias nuevas ni build step — todo el código sigue siendo
  HTML/CSS/JS plano cargado directo por el navegador.
- Seguir la paleta y componentes visuales ya definidos en `styles.css`
  (`.fullscreen-overlay`, `.fs-header`, `.fs-content`, `.sheet-overlay`, `.sheet`,
  `.list-item`, `.li-badge`, `.toggle-group`/`.toggle-btn`, `.chip-row`/`.chip`, `.field`,
  `.fab`, `.quick-action`/`.quick-action-alt`/`.quick-action-outline`, `.btn-primary`/
  `.btn-outline`) — no introducir un sistema visual paralelo.
- Las funciones SQL siguen el estilo ya establecido por `registrar_venta`/`anular_venta`/
  `crear_usuario`: `plpgsql`, `SECURITY DEFINER`, `SET search_path TO 'public'` (agregar
  también `'extensions'` únicamente si la función usa `crypt()`/`gen_salt()` — ninguna de
  las funciones nuevas de este ticket los usa), errores de negocio comunicados con
  `RAISE EXCEPTION '<CODIGO_EN_MAYUSCULAS>'` que el cliente detecta con
  `error.message.includes(...)`.
- No hay framework de pruebas automatizadas en este proyecto — la verificación de cada
  tarea es manual: SQL directo contra Supabase (para las funciones) y navegador (para la
  UI), documentando el resultado igual que en los tickets 01-12 de `TICKETS.md`.
- Cada vez que se modifica `app.js` o `styles.css`, subir el número en `sw.js` →
  `const CACHE = 'vf-vX'` (actualmente `vf-v5`, este ticket la sube a `vf-v6` en la Task
  13 de cierre).
- **Datos reales de referencia al momento de escribir este plan:** usuarios `Papá`
  (admin), `Angie`/`Alexa`/`Alexis` (vendedor) — pueden existir más si Luis dio de alta
  usuarios nuevos en el ticket 12; producto real `Playera polo azul` con 46 unidades. Los
  pasos de verificación usan estos nombres como referencia — ajustar a lo que exista
  realmente al momento de ejecutar (confirmar con `select nombre, rol, activo from
  usuarios` y `select nombre from productos` antes de cada task de verificación).
- **Nota de migración de datos (irreversible una vez hecha la Task 1):** el stock actual de
  cada producto se asigna completo a Central — no hay forma de reconstruir si en la
  realidad ya estaba repartido entre vendedores; Luis deberá registrar los traspasos reales
  manualmente después de la migración (vía la pantalla "Movimientos" que este mismo plan
  construye, Task 12) para que el desglose por almacén refleje la realidad física.

---

### Task 1: Esquema — `almacenes`, `stock_almacen`, `movimientos_almacen` + migración de datos

**Files:**
- Supabase (proyecto `wiewxgkiefsjeonirsid`), vía `apply_migration` con nombre
  `multi_almacen_esquema`. No hay archivo `.sql` local.

**Interfaces:**
- Consumes: tabla `usuarios` (`id, nombre`, ya existente); tabla `productos` (`id, stock`,
  ya existente — esta task le quita la columna `stock`).
- Produces: tablas `almacenes(id, nombre, usuario_id)`, `stock_almacen(producto_id,
  almacen_id, cantidad)`, `movimientos_almacen(id, producto_id, almacen_origen_id,
  almacen_destino_id, cantidad, usuario_id, anulado, anulado_por, anulado_en, creado_en)`.
  Consumido por todas las demás tasks de este plan.

- [ ] **Step 1: Confirmar el estado actual antes de migrar**

Ejecutar con `execute_sql` (o el SQL Editor si `execute_sql` no está disponible):

```sql
select nombre, stock from productos order by nombre;
select nombre, rol, activo from usuarios order by nombre;
```

Anotar estos resultados — son los que la migración va a distribuir hacia `stock_almacen`
(todo a Central) y hacia un almacén por usuario (vacíos, en 0).

- [ ] **Step 2: Aplicar la migración de esquema**

Ejecutar con `apply_migration` (`project_id: wiewxgkiefsjeonirsid`, `name:
multi_almacen_esquema`):

```sql
-- Almacenes: Central (usuario_id null) + uno por usuario existente
create table almacenes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  usuario_id uuid references usuarios(id),
  creado_en timestamptz not null default now()
);
create unique index almacenes_usuario_id_unique_idx
  on almacenes(usuario_id) where usuario_id is not null;

insert into almacenes (nombre, usuario_id) values ('Central', null);
insert into almacenes (nombre, usuario_id)
  select nombre, id from usuarios;

-- Stock distribuido por almacén — reemplaza productos.stock
create table stock_almacen (
  producto_id uuid not null references productos(id),
  almacen_id uuid not null references almacenes(id),
  cantidad integer not null default 0 check (cantidad >= 0),
  primary key (producto_id, almacen_id)
);

-- Backfill: el stock actual de cada producto se asigna completo a Central
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
create index movimientos_almacen_producto_id_idx
  on movimientos_almacen(producto_id);
```

- [ ] **Step 3: Verificar la migración con datos reales**

Intentar primero con `execute_sql`. Si en tu sesión regresa resultados legibles, usar
directamente:

```sql
-- Debe existir exactamente un almacén "Central" (usuario_id null)
select nombre, usuario_id from almacenes where usuario_id is null;

-- Debe existir exactamente un almacén por cada usuario (sin duplicados)
select u.nombre, count(a.id) as almacenes
from usuarios u left join almacenes a on a.usuario_id = u.id
group by u.nombre
having count(a.id) <> 1;
-- Esperado: 0 filas (si regresa alguna, ese usuario no tiene almacén o tiene más de uno)

-- El stock de cada producto debe haberse copiado completo a su fila en Central
select p.nombre, sa.cantidad
from productos p
join stock_almacen sa on sa.producto_id = p.id
join almacenes a on a.id = sa.almacen_id and a.nombre = 'Central';
-- Esperado: mismos valores que el "select nombre, stock from productos" del Step 1

-- productos.stock ya no existe
select column_name from information_schema.columns
where table_name = 'productos' and column_name = 'stock';
-- Esperado: 0 filas
```

Si `execute_sql` regresa contenido ilegible/truncado, usar en su lugar `apply_migration`
con este bloque de asserts (nombre de migración: `multi_almacen_esquema_verify` — es un
descarte de diagnóstico, no altera datos):

```sql
do $$
declare
  v_centrales int;
  v_usuarios_sin_almacen int;
  v_columna_stock int;
begin
  select count(*) into v_centrales from almacenes where usuario_id is null;
  if v_centrales <> 1 then
    raise exception 'FALLO: esperaba exactamente 1 almacen Central, hay %', v_centrales;
  end if;

  select count(*) into v_usuarios_sin_almacen
  from usuarios u
  where not exists (select 1 from almacenes a where a.usuario_id = u.id);
  if v_usuarios_sin_almacen <> 0 then
    raise exception 'FALLO: % usuarios sin almacen propio', v_usuarios_sin_almacen;
  end if;

  select count(*) into v_columna_stock
  from information_schema.columns
  where table_name = 'productos' and column_name = 'stock';
  if v_columna_stock <> 0 then
    raise exception 'FALLO: productos.stock todavia existe';
  end if;

  raise exception 'OK: los 3 asserts de Task 1 pasaron correctamente';
end $$;
```

Expected: el bloque `do $$` termina siempre con un error por diseño — lo que importa es el
texto: `OK: ...` significa que pasó, `FALLO: ...` significa que hay que revisar el Step 2.

---

### Task 2: Función SQL `crear_producto` (alta de producto con stock inicial atómico)

**Files:**
- Supabase, vía `apply_migration` con nombre `crear_producto_fn`.

**Interfaces:**
- Consumes: tablas `productos`, `stock_almacen`, `movimientos_almacen`, `almacenes`
  (Task 1).
- Produces: `crear_producto(p_nombre text, p_precio numeric, p_costo numeric, p_foto_url
  text, p_categoria text, p_stock_inicial int, p_usuario_id uuid) returns table(id uuid,
  nombre text, precio numeric, costo numeric, foto_url text, categoria text)`, consumida
  por Task 10 (`app.js`, `saveProducto()`). Errores: `DATOS_INVALIDOS`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.crear_producto(
  p_nombre text, p_precio numeric, p_costo numeric, p_foto_url text,
  p_categoria text, p_stock_inicial int, p_usuario_id uuid
)
returns table(id uuid, nombre text, precio numeric, costo numeric, foto_url text, categoria text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_central_id uuid;
begin
  if p_nombre is null or trim(p_nombre) = '' then
    raise exception 'DATOS_INVALIDOS';
  end if;
  if p_precio is null or p_precio <= 0 then
    raise exception 'DATOS_INVALIDOS';
  end if;
  if p_costo is null or p_costo <= 0 then
    raise exception 'DATOS_INVALIDOS';
  end if;
  if p_stock_inicial is null or p_stock_inicial < 0 then
    raise exception 'DATOS_INVALIDOS';
  end if;

  insert into productos (nombre, precio, costo, foto_url, categoria)
  values (trim(p_nombre), p_precio, p_costo, p_foto_url, p_categoria)
  returning productos.id into v_id;

  if p_stock_inicial > 0 then
    select a.id into v_central_id from almacenes a where a.nombre = 'Central';

    insert into stock_almacen (producto_id, almacen_id, cantidad)
    values (v_id, v_central_id, p_stock_inicial)
    on conflict (producto_id, almacen_id) do update
      set cantidad = stock_almacen.cantidad + excluded.cantidad;

    insert into movimientos_almacen
      (producto_id, almacen_origen_id, almacen_destino_id, cantidad, usuario_id)
    values (v_id, null, v_central_id, p_stock_inicial, p_usuario_id);
  end if;

  return query
  select p.id, p.nombre, p.precio, p.costo, p.foto_url, p.categoria
  from productos p where p.id = v_id;
end;
$function$;
```

- [ ] **Step 2: Verificar con datos reales usando `execute_sql`**

```sql
-- Alta con stock inicial > 0
select * from crear_producto(
  'Test Producto Con Stock', 100.00, 50.00, 'https://ejemplo.com/foto.jpg', 'Prueba', 10,
  (select id from usuarios where nombre = 'Papá')
);
-- Esperado: 1 fila con el producto creado

select sa.cantidad from stock_almacen sa
join productos p on p.id = sa.producto_id
join almacenes a on a.id = sa.almacen_id and a.nombre = 'Central'
where p.nombre = 'Test Producto Con Stock';
-- Esperado: 10

select cantidad, almacen_origen_id from movimientos_almacen m
join productos p on p.id = m.producto_id
where p.nombre = 'Test Producto Con Stock';
-- Esperado: 1 fila, cantidad=10, almacen_origen_id=null

-- Alta con stock inicial 0 → no genera movimiento
select * from crear_producto(
  'Test Producto Sin Stock', 100.00, 50.00, 'https://ejemplo.com/foto.jpg', 'Prueba', 0,
  (select id from usuarios where nombre = 'Papá')
);
select count(*) from movimientos_almacen m
join productos p on p.id = m.producto_id
where p.nombre = 'Test Producto Sin Stock';
-- Esperado: 0

-- Datos inválidos
select * from crear_producto('', 100.00, 50.00, 'x', null, 5, (select id from usuarios where nombre = 'Papá'));
-- Esperado: error "DATOS_INVALIDOS"
select * from crear_producto('Test Precio Malo', 0, 50.00, 'x', null, 5, (select id from usuarios where nombre = 'Papá'));
-- Esperado: error "DATOS_INVALIDOS"
```

Expected: los cinco resultados coinciden. Confirmar que los intentos con datos inválidos no
dejaron ninguna fila parcial en `productos`.

- [ ] **Step 3: Limpiar los datos de prueba**

```sql
delete from movimientos_almacen where producto_id in (
  select id from productos where nombre in ('Test Producto Con Stock', 'Test Producto Sin Stock')
);
delete from stock_almacen where producto_id in (
  select id from productos where nombre in ('Test Producto Con Stock', 'Test Producto Sin Stock')
);
delete from productos where nombre in ('Test Producto Con Stock', 'Test Producto Sin Stock');
```

---

### Task 3: Función SQL `registrar_entrada`

**Files:**
- Supabase, vía `apply_migration` con nombre `registrar_entrada_fn`.

**Interfaces:**
- Consumes: tablas `usuarios`, `almacenes`, `stock_almacen`, `movimientos_almacen`
  (Task 1).
- Produces: `registrar_entrada(p_producto_id uuid, p_cantidad int, p_usuario_id uuid)
  returns void`, consumida por Task 10 (`app.js`, botón "Registrar entrada") y Task 12
  (formulario de movimientos, tipo "Entrada"). Errores: `PERMISO_DENEGADO`,
  `MOVIMIENTO_INVALIDO`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.registrar_entrada(
  p_producto_id uuid, p_cantidad int, p_usuario_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rol text;
  v_activo boolean;
  v_central_id uuid;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_usuario_id;
  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'MOVIMIENTO_INVALIDO';
  end if;

  select id into v_central_id from almacenes where nombre = 'Central';

  insert into stock_almacen (producto_id, almacen_id, cantidad)
  values (p_producto_id, v_central_id, p_cantidad)
  on conflict (producto_id, almacen_id) do update
    set cantidad = stock_almacen.cantidad + excluded.cantidad;

  insert into movimientos_almacen
    (producto_id, almacen_origen_id, almacen_destino_id, cantidad, usuario_id)
  values (p_producto_id, null, v_central_id, p_cantidad, p_usuario_id);
end;
$function$;
```

- [ ] **Step 2: Verificar con datos reales usando `execute_sql`**

```sql
-- Cantidad de Central antes
select cantidad from stock_almacen sa
join productos p on p.id = sa.producto_id
join almacenes a on a.id = sa.almacen_id and a.nombre = 'Central'
where p.nombre = 'Playera polo azul';

-- Entrada válida de 20
select registrar_entrada(
  (select id from productos where nombre = 'Playera polo azul'),
  20,
  (select id from usuarios where nombre = 'Papá')
);
-- Repetir el select de arriba: debe haber subido exactamente 20

-- Un vendedor no puede registrar entradas
select registrar_entrada(
  (select id from productos where nombre = 'Playera polo azul'),
  5,
  (select id from usuarios where nombre = 'Angie')
);
-- Esperado: error "PERMISO_DENEGADO"

-- Cantidad inválida
select registrar_entrada(
  (select id from productos where nombre = 'Playera polo azul'),
  0,
  (select id from usuarios where nombre = 'Papá')
);
-- Esperado: error "MOVIMIENTO_INVALIDO"
```

Expected: los cuatro resultados coinciden; el intento de vendedor y el de cantidad
inválida no modificaron `stock_almacen`.

- [ ] **Step 3: Revertir el dato de prueba (dejar Central como estaba antes del Step 2)**

```sql
update stock_almacen set cantidad = cantidad - 20
where producto_id = (select id from productos where nombre = 'Playera polo azul')
  and almacen_id = (select id from almacenes where nombre = 'Central');

delete from movimientos_almacen
where producto_id = (select id from productos where nombre = 'Playera polo azul')
  and cantidad = 20 and almacen_origen_id is null
  and creado_en > now() - interval '10 minutes';
```

---

### Task 4: Función SQL `registrar_traspaso`

**Files:**
- Supabase, vía `apply_migration` con nombre `registrar_traspaso_fn`.

**Interfaces:**
- Consumes: tablas `usuarios`, `stock_almacen`, `movimientos_almacen` (Task 1).
- Produces: `registrar_traspaso(p_producto_id uuid, p_almacen_origen_id uuid,
  p_almacen_destino_id uuid, p_cantidad int, p_usuario_id uuid) returns void`, consumida
  por Task 12 (formulario de movimientos, tipo "Traspaso"). Errores: `PERMISO_DENEGADO`,
  `MOVIMIENTO_INVALIDO`, `STOCK_INSUFICIENTE`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.registrar_traspaso(
  p_producto_id uuid, p_almacen_origen_id uuid, p_almacen_destino_id uuid,
  p_cantidad int, p_usuario_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rol text;
  v_activo boolean;
  v_cantidad_origen int;
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

  insert into movimientos_almacen
    (producto_id, almacen_origen_id, almacen_destino_id, cantidad, usuario_id)
  values (p_producto_id, p_almacen_origen_id, p_almacen_destino_id, p_cantidad, p_usuario_id);
end;
$function$;
```

- [ ] **Step 2: Setup — asegurar que Central tenga stock suficiente para probar**

```sql
select registrar_entrada(
  (select id from productos where nombre = 'Playera polo azul'), 20,
  (select id from usuarios where nombre = 'Papá')
);
```

- [ ] **Step 3: Verificar el caso normal — Central → Angie, luego Angie → Alexa directo**

```sql
-- Central -> Angie (5 unidades)
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  5,
  (select id from usuarios where nombre = 'Papá')
);

select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul'
order by dueno;
-- Esperado: Central bajó 5, Angie subió 5

-- Angie -> Alexa directo (sin pasar por Central), 3 unidades
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexa'),
  3,
  (select id from usuarios where nombre = 'Papá')
);
-- Repetir el select de arriba: Angie baja a 2, Alexa sube a 3, Central sin cambio
```

- [ ] **Step 4: Verificar validaciones — permisos, mismo almacén, stock insuficiente**

```sql
-- Vendedor no puede traspasar
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexis'),
  1,
  (select id from usuarios where nombre = 'Angie')
);
-- Esperado: error "PERMISO_DENEGADO"

-- Origen y destino iguales
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes where nombre = 'Central'),
  1,
  (select id from usuarios where nombre = 'Papá')
);
-- Esperado: error "MOVIMIENTO_INVALIDO"

-- Traspasar más de lo que Alexa tiene (Alexa tiene 3, pedir 100)
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexa'),
  (select id from almacenes where nombre = 'Central'),
  100,
  (select id from usuarios where nombre = 'Papá')
);
-- Esperado: error "STOCK_INSUFICIENTE" — Alexa sigue con 3, nada cambia
```

Expected: los tres bloqueos ocurren y ninguno modificó `stock_almacen`.

- [ ] **Step 5: Revertir todos los traspasos de prueba (dejar todo de vuelta en Central)**

```sql
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  (select id from almacenes where nombre = 'Central'),
  2,
  (select id from usuarios where nombre = 'Papá')
);
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexa'),
  (select id from almacenes where nombre = 'Central'),
  3,
  (select id from usuarios where nombre = 'Papá')
);
update stock_almacen set cantidad = cantidad - 20
where producto_id = (select id from productos where nombre = 'Playera polo azul')
  and almacen_id = (select id from almacenes where nombre = 'Central');

select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul' and sa.cantidad > 0
order by dueno;
-- Esperado: únicamente Central, con el valor que tenía antes de la Task 3/4 (46 si nadie
-- más lo tocó en paralelo)
```

---

### Task 5: Función SQL `anular_movimiento`

**Files:**
- Supabase, vía `apply_migration` con nombre `anular_movimiento_fn`.

**Interfaces:**
- Consumes: tablas `usuarios`, `stock_almacen`, `movimientos_almacen` (Task 1).
- Produces: `anular_movimiento(p_movimiento_id uuid, p_usuario_id uuid) returns void`,
  consumida por Task 12 (botón "Anular" en el panel de movimientos). Errores:
  `PERMISO_DENEGADO`, `NO_ENCONTRADO`, `YA_ANULADO`, `STOCK_INSUFICIENTE_PARA_ANULAR`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.anular_movimiento(
  p_movimiento_id uuid, p_usuario_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rol text;
  v_activo boolean;
  v_mov record;
  v_cantidad_destino int;
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

  update movimientos_almacen
  set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
  where id = p_movimiento_id;
end;
$function$;
```

- [ ] **Step 2: Verificar anular un traspaso reciente (destino con la cantidad completa)**

```sql
-- Traspaso de prueba: Central -> Angie, 5 unidades
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  5,
  (select id from usuarios where nombre = 'Papá')
);

select id from movimientos_almacen
where producto_id = (select id from productos where nombre = 'Playera polo azul')
order by creado_en desc limit 1;
-- Anotar este id como <MOV_ID>

select anular_movimiento('<MOV_ID>', (select id from usuarios where nombre = 'Papá'));

select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul' and sa.cantidad > 0;
-- Esperado: Central recupera las 5, Angie vuelve a 0 (o desaparece/queda en 0)

select anulado, anulado_por from movimientos_almacen where id = '<MOV_ID>';
-- Esperado: anulado=true, anulado_por = id de Papá
```

- [ ] **Step 3: Verificar el bloqueo — destino ya no tiene suficiente para revertir**

```sql
-- Nuevo traspaso: Central -> Angie, 5 unidades
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  5,
  (select id from usuarios where nombre = 'Papá')
);
select id from movimientos_almacen
where producto_id = (select id from productos where nombre = 'Playera polo azul')
order by creado_en desc limit 1;
-- Anotar como <MOV_ID_2>

-- Angie re-traspasa esas 5 a Alexa (ya no las tiene ella)
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexa'),
  5,
  (select id from usuarios where nombre = 'Papá')
);

-- Intentar anular el traspaso original Central->Angie
select anular_movimiento('<MOV_ID_2>', (select id from usuarios where nombre = 'Papá'));
-- Esperado: error "STOCK_INSUFICIENTE_PARA_ANULAR" — nada cambia

-- Vendedor no puede anular
select anular_movimiento('<MOV_ID_2>', (select id from usuarios where nombre = 'Angie'));
-- Esperado: error "PERMISO_DENEGADO"

-- Movimiento inexistente
select anular_movimiento(gen_random_uuid(), (select id from usuarios where nombre = 'Papá'));
-- Esperado: error "NO_ENCONTRADO"
```

- [ ] **Step 4: Verificar anular una entrada (no un traspaso) y doble anulación**

```sql
select registrar_entrada(
  (select id from productos where nombre = 'Playera polo azul'), 10,
  (select id from usuarios where nombre = 'Papá')
);
select id from movimientos_almacen
where producto_id = (select id from productos where nombre = 'Playera polo azul')
  and almacen_origen_id is null
order by creado_en desc limit 1;
-- Anotar como <MOV_ENTRADA_ID>

select anular_movimiento('<MOV_ENTRADA_ID>', (select id from usuarios where nombre = 'Papá'));
-- Central pierde esas 10 (no hay origen que restaurar)

select anular_movimiento('<MOV_ENTRADA_ID>', (select id from usuarios where nombre = 'Papá'));
-- Esperado: error "YA_ANULADO"
```

Expected: los cuatro escenarios (revertir traspaso normal, bloqueo por stock insuficiente,
permisos, movimiento inexistente) y este último (entrada + doble anulación) se comportan
como se describe.

- [ ] **Step 5: Dejar el stock de `Playera polo azul` como estaba antes de las Tasks 3-5**

```sql
select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul' and sa.cantidad > 0;
```

Revertir manualmente con `registrar_traspaso`/ajustes directos hasta que únicamente
Central tenga cantidad, con el valor original (46 si nadie más lo tocó en paralelo desde
la Task 1).

---

### Task 6: Rework de `registrar_venta()` — descuenta del almacén propio del vendedor

**Files:**
- Supabase, vía `apply_migration` con nombre `registrar_venta_multialmacen`.

**Interfaces:**
- Consumes: `stock_almacen`, `almacenes` (Task 1); firma y demás lógica de
  `registrar_venta()` ya desplegada (tickets 05/06/11) — **debe leerse en vivo antes de
  modificarla**, ver Step 1.
- Produces: `registrar_venta()` con el mismo nombre/firma/mensajes de error visibles al
  cliente (`STOCK_INSUFICIENTE`) — el frontend (`app.js`) no necesita cambiar su manejo de
  errores. Consumida por el flujo de venta ya existente (`confirmarVenta()`, `app.js:849`).

- [ ] **Step 1: Leer la definición actual desplegada de `registrar_venta()`**

Esta función se ha modificado dos veces antes (tickets 05, 06 y 11) y su cuerpo exacto no
está en este repo (el proyecto no versiona SQL). Antes de tocarla, obtener el texto real
con `execute_sql`:

```sql
select pg_get_functiondef('public.registrar_venta'::regproc);
```

Si `execute_sql` regresa el texto legible, úsalo directo. Si regresa contenido
truncado/ilegible, usar `apply_migration` con nombre `probe_registrar_venta` (descarte de
diagnóstico) con este bloque, que siempre termina en un `raise exception` con el texto
completo:

```sql
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.registrar_venta'::regproc) into v_def;
  raise exception '%', v_def;
end $$;
```

- [ ] **Step 2: Localizar y transformar el bloque de stock dentro del cuerpo obtenido**

El cuerpo actual, por cada item del carrito, hace aproximadamente esto (basado en el
diseño original de los tickets 05/06 — confirmar contra el texto real del Step 1 antes de
copiar/pegar):

```sql
-- ANTES (versión actual, referencia únicamente — usar el texto real del Step 1):
select stock into v_stock_actual from productos where id = item.producto_id for update;
if v_stock_actual < item.cantidad then
  raise exception 'STOCK_INSUFICIENTE';
end if;
update productos set stock = stock - item.cantidad where id = item.producto_id;
```

Reemplazar ese bloque específico (dejando folio, `venta_items`, `costo_unitario`,
`venta_pagos`, saldo del cliente — todo lo demás de la función — exactamente igual al
texto obtenido en el Step 1) por:

```sql
-- DESPUÉS:
select a.id into v_almacen_id from almacenes a where a.usuario_id = p_vendedor_id;

select cantidad into v_stock_actual
from stock_almacen
where producto_id = item.producto_id and almacen_id = v_almacen_id
for update;

if v_stock_actual is null or v_stock_actual < item.cantidad then
  raise exception 'STOCK_INSUFICIENTE';
end if;

update stock_almacen set cantidad = cantidad - item.cantidad
where producto_id = item.producto_id and almacen_id = v_almacen_id;
```

Declarar `v_almacen_id uuid;` junto a las demás variables `declare` de la función si no
existe ya. `v_almacen_id` se resuelve una sola vez por venta (fuera del loop de items, ya
que todos los items de una venta salen del mismo almacén del vendedor) o dentro del loop —
cualquiera de las dos es correcta porque el valor no cambia; seguir el estilo del resto de
la función (si ya declara variables fuera del loop, declarar ahí).

Aplicar la función completa modificada con `apply_migration` (nombre
`registrar_venta_multialmacen`).

- [ ] **Step 3: Verificar — venta descuenta del almacén propio, no de Central ni de otros**

```sql
-- Dar stock a Angie para la prueba
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  10,
  (select id from usuarios where nombre = 'Papá')
);

-- Angie vende 3 (contado, sin cliente)
select * from registrar_venta(
  'contado', null,
  (select id from usuarios where nombre = 'Angie'),
  0,
  jsonb_build_array(jsonb_build_object(
    'producto_id', (select id from productos where nombre = 'Playera polo azul'),
    'cantidad', 3,
    'precio_unitario', 100.00
  ))
);
-- Ajustar el nombre de los parámetros/tipos exactamente a la firma real leída en el Step 1
-- si difiere de este ejemplo (p_items podría esperar un tipo distinto a jsonb según cómo
-- esté declarado hoy) -- confirmar con \df registrar_venta o el texto del Step 1.

select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul' and sa.cantidad > 0;
-- Esperado: Angie bajó de 10 a 7; Central sin cambio

-- Angie intenta vender más de lo que tiene en su propio almacén (tiene 7, Central sí
-- tiene mucho más, pero eso no debe importar)
select * from registrar_venta(
  'contado', null,
  (select id from usuarios where nombre = 'Angie'),
  0,
  jsonb_build_array(jsonb_build_object(
    'producto_id', (select id from productos where nombre = 'Playera polo azul'),
    'cantidad', 999,
    'precio_unitario', 100.00
  ))
);
-- Esperado: error "STOCK_INSUFICIENTE"
```

Expected: la venta exitosa descuenta únicamente del almacén de Angie; el intento de
sobre-vender se bloquea aunque Central tenga stock de sobra.

- [ ] **Step 4: Revertir el stock de prueba**

```sql
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Angie'),
  (select id from almacenes where nombre = 'Central'),
  7,
  (select id from usuarios where nombre = 'Papá')
);
```

Si la venta de prueba del Step 3 quedó registrada de verdad en `ventas`/`venta_items`
(no había forma de hacer un "dry run"), anularla con `anular_venta()` para no dejar un
registro de venta ficticio en el historial real — usar el flujo normal: `select * from
ventas where vendedor_id = (select id from usuarios where nombre = 'Angie') order by
creado_en desc limit 1;` para obtener el id, luego `select anular_venta(<ese id>, (select
id from usuarios where nombre = 'Papá'));`.

---

### Task 7: Rework de `anular_venta()` — repone al almacén del vendedor de esa venta

**Files:**
- Supabase, vía `apply_migration` con nombre `anular_venta_multialmacen`.

**Interfaces:**
- Consumes: `stock_almacen`, `almacenes` (Task 1); firma y demás lógica de
  `anular_venta()` ya desplegada (ticket 11) — leer en vivo antes de modificar, mismo
  patrón que Task 6.
- Produces: `anular_venta()` con el mismo nombre/firma/mensajes de error visibles al
  cliente (`PERMISO_DENEGADO`, `YA_ANULADO`). Consumida por el flujo ya existente
  (`confirmarAnular()`, `app.js:1255`).

- [ ] **Step 1: Leer la definición actual desplegada de `anular_venta()`**

```sql
select pg_get_functiondef('public.anular_venta'::regproc);
```

Si sale ilegible, usar el mismo patrón de `do $$ ... raise exception '%', v_def; end $$;`
de la Task 6, Step 1, con `apply_migration` (nombre `probe_anular_venta`).

- [ ] **Step 2: Localizar y transformar el bloque que repone stock**

El cuerpo actual repone stock aproximadamente así (confirmar contra el texto real del
Step 1):

```sql
-- ANTES (referencia, confirmar con el texto real):
update productos set stock = stock + vi.cantidad
where id = vi.producto_id;
```

(probablemente dentro de un loop `for vi in select * from venta_items where venta_id =
p_venta_id loop ... end loop;`, o con una sola sentencia agregada — seguir la estructura
real). Reemplazar por:

```sql
-- DESPUÉS: resolver el almacén del vendedor de esa venta una sola vez
select a.id into v_almacen_id
from almacenes a
join ventas v on v.vendedor_id = a.usuario_id
where v.id = p_venta_id;

-- y dentro del mismo loop/agregación que ya recorre venta_items:
insert into stock_almacen (producto_id, almacen_id, cantidad)
values (vi.producto_id, v_almacen_id, vi.cantidad)
on conflict (producto_id, almacen_id) do update
  set cantidad = stock_almacen.cantidad + excluded.cantidad;
```

Declarar `v_almacen_id uuid;` junto a las demás variables si no existe. El resto de la
función (rama de crédito, `saldo_pendiente_venta`, marcar `anulado`/`anulado_por`/
`anulado_en`) permanece exactamente igual al texto del Step 1.

Aplicar con `apply_migration` (nombre `anular_venta_multialmacen`).

- [ ] **Step 3: Verificar — anular repone al almacén del vendedor, no a Central**

```sql
-- Dar stock a Alexis y que venda algo
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes where nombre = 'Central'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexis'),
  8,
  (select id from usuarios where nombre = 'Papá')
);

select * from registrar_venta(
  'contado', null,
  (select id from usuarios where nombre = 'Alexis'),
  0,
  jsonb_build_array(jsonb_build_object(
    'producto_id', (select id from productos where nombre = 'Playera polo azul'),
    'cantidad', 4,
    'precio_unitario', 100.00
  ))
);
-- Ajustar tipos/nombres de parámetros a la firma real si difiere.

select id from ventas
where vendedor_id = (select id from usuarios where nombre = 'Alexis')
order by creado_en desc limit 1;
-- Anotar como <VENTA_ID>

select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul' and dueno = 'Alexis';
-- Esperado: 4 (8 - 4 vendidas)

select anular_venta('<VENTA_ID>', (select id from usuarios where nombre = 'Papá'));

select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where p.nombre = 'Playera polo azul' and dueno = 'Alexis';
-- Esperado: 8 (recuperó las 4) — nunca tocó la fila de Central
```

Expected: la reposición llega específicamente al almacén de Alexis.

- [ ] **Step 4: Revertir el stock de prueba**

```sql
select registrar_traspaso(
  (select id from productos where nombre = 'Playera polo azul'),
  (select id from almacenes a join usuarios u on u.id = a.usuario_id where u.nombre = 'Alexis'),
  (select id from almacenes where nombre = 'Central'),
  8,
  (select id from usuarios where nombre = 'Papá')
);
```

---

### Task 8: Rework de `crear_usuario()` — crea el almacén del usuario en la misma operación

**Files:**
- Supabase, vía `apply_migration` con nombre `crear_usuario_multialmacen`.

**Interfaces:**
- Consumes: tabla `almacenes` (Task 1); `crear_usuario()` ya desplegada (ticket 12) —
  leer en vivo antes de modificar.
- Produces: `crear_usuario()` con la misma firma (`p_nombre, p_password, p_rol`) y los
  mismos errores (`ROL_INVALIDO`, `DATOS_INVALIDOS`, `23505`). Consumida sin cambios por
  `app.js:1654` (Task 10 de ticket 12, ya en producción).

- [ ] **Step 1: Leer la definición actual desplegada de `crear_usuario()`**

```sql
select pg_get_functiondef('public.crear_usuario'::regproc);
```

El texto esperado (según el plan del ticket 12, Task 2 — confirmar que coincide, ya que
podría haber cambiado con el fix "Fix I-1" del commit `9af853c`, que tocó
`cambiar_estatus_usuario`/`actualizar_datos_usuario`, no necesariamente `crear_usuario`):

```sql
CREATE OR REPLACE FUNCTION public.crear_usuario(p_nombre text, p_password text, p_rol text)
 RETURNS TABLE(id uuid, nombre text, rol text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_id uuid;
begin
  if p_rol not in ('admin', 'vendedor') then
    raise exception 'ROL_INVALIDO';
  end if;

  if p_nombre is null or trim(p_nombre) = '' or p_password is null or p_password = '' then
    raise exception 'DATOS_INVALIDOS';
  end if;

  insert into usuarios (nombre, rol, password_hash, activo)
  values (trim(p_nombre), p_rol, crypt(p_password, gen_salt('bf')), true)
  returning usuarios.id into v_id;

  return query select u.id, u.nombre, u.rol from usuarios u where u.id = v_id;
end;
$function$
```

- [ ] **Step 2: Agregar la creación del almacén, preservando el resto del cuerpo real**

Insertar una línea después del `insert into usuarios ... returning usuarios.id into
v_id;` confirmado en el Step 1 (usar el texto real si difiere del de referencia de arriba):

```sql
  insert into almacenes (nombre, usuario_id) values (trim(p_nombre), v_id);
```

Aplicar la función completa (con esa única línea agregada, todo lo demás igual al texto
real leído en el Step 1) vía `apply_migration` (nombre `crear_usuario_multialmacen`).

- [ ] **Step 3: Verificar con datos reales usando `execute_sql`**

```sql
select * from crear_usuario('Test Usuario Con Almacen', 'clave123', 'vendedor');

select a.id, a.usuario_id from almacenes a
join usuarios u on u.id = a.usuario_id
where u.nombre = 'Test Usuario Con Almacen';
-- Esperado: exactamente 1 fila (el usuario ya tiene su almacén propio)
```

Expected: el usuario nuevo queda con exactamente un almacén propio, sin necesidad de
ningún paso manual adicional.

- [ ] **Step 4: Limpiar el dato de prueba**

```sql
delete from almacenes where usuario_id = (select id from usuarios where nombre = 'Test Usuario Con Almacen');
delete from usuarios where nombre = 'Test Usuario Con Almacen';
```

---

### Task 9: Login — agregar `session.almacenId`

**Files:**
- Modify: `app.js:94-131` (`handleLogin()` — resolver y guardar el almacén propio del
  usuario en la sesión)
- Modify: `app.js:1742-1765` (`init()` — parchar sesiones ya guardadas en localStorage que
  no tengan `almacenId` todavía, para que una sesión abierta antes de este ticket no se
  quede con el carrito roto hasta hacer logout/login manual)

**Interfaces:**
- Consumes: tabla `almacenes` (Task 1), `getSession()`/`setSession()` ya existentes.
- Produces: `session.almacenId` disponible en cualquier punto del código que llame
  `getSession()` después del login — consumido por Task 11 (carrito de venta).

- [ ] **Step 1: Resolver el almacén propio justo después de un login exitoso**

En `app.js`, reemplazar (líneas 118-126):

```js
    if (!data || data.length === 0) {
      errorEl.textContent = 'Usuario o contraseña incorrectos.';
      return;
    }

    const user = data[0];
    setSession(user);
    document.getElementById('login-form').reset();
    renderMain(user);
```

por:

```js
    if (!data || data.length === 0) {
      errorEl.textContent = 'Usuario o contraseña incorrectos.';
      return;
    }

    const user = data[0];
    const { data: almacenData } = await supabase
      .from('almacenes')
      .select('id')
      .eq('usuario_id', user.id)
      .single();
    user.almacenId = almacenData ? almacenData.id : null;

    setSession(user);
    document.getElementById('login-form').reset();
    renderMain(user);
```

- [ ] **Step 2: Parchar sesiones existentes sin `almacenId` al restaurar desde localStorage**

En `app.js`, dentro de `function init()` (línea ~1742), reemplazar:

```js
  populateLoginUsuarios();
  const session = getSession();
  if (session) {
    renderMain(session);
  } else {
    showView('view-login');
  }
```

por:

```js
  populateLoginUsuarios();
  const session = getSession();
  if (session) {
    if (!session.almacenId) {
      supabase
        .from('almacenes')
        .select('id')
        .eq('usuario_id', session.id)
        .single()
        .then(({ data }) => {
          if (data) {
            session.almacenId = data.id;
            setSession(session);
          }
        });
    }
    renderMain(session);
  } else {
    showView('view-login');
  }
```

`setSession` ya está declarada (no exportada) más arriba en el mismo módulo — no requiere
import adicional al ser el mismo archivo.

- [ ] **Step 3: Verificar en el navegador**

Cerrar sesión (o abrir en una pestaña nueva) y entrar como "Angie". Abrir la consola del
navegador y ejecutar `JSON.parse(localStorage.getItem('vf_user'))`.

Expected: el objeto de sesión incluye `almacenId` con un uuid no nulo. Repetir con "Papá"
(admin) — también debe traer su propio `almacenId`, distinto al de Angie.

Para probar el parche de sesiones viejas: en la consola, ejecutar
`localStorage.setItem('vf_user', JSON.stringify({id: '<id de Angie>', nombre: 'Angie',
rol: 'vendedor'}))` (sin `almacenId`) y recargar la página. Expected: la app entra
directo a la vista principal como Angie (sesión restaurada) y, tras un instante,
`JSON.parse(localStorage.getItem('vf_user')).almacenId` ya trae el uuid correcto sin que
Angie haya tenido que volver a iniciar sesión.

---

### Task 10: Frontend Inventario — stock por almacén (solo lectura) + "Registrar entrada" + alta vía `crear_producto()`

**Files:**
- Modify: `index.html:206-240` (`#producto-sheet` — ocultar el campo Stock en modo
  edición, agregar sección de solo lectura "Stock por almacén" y el mini-formulario
  "Registrar entrada", ambos solo en modo edición)
- Modify: `app.js:353-546` (sección "Inventario" — `loadProductos()`, `openProductoForm()`,
  `saveProducto()`, nuevas `loadStockPorAlmacen()`, `renderStockPorAlmacen()`,
  `registrarEntradaProducto()`, `initInventario()`)
- Modify: `styles.css` (agregar estilos nuevos al final)

**Interfaces:**
- Consumes: `crear_producto()` (Task 2), `registrar_entrada()` (Task 3), `getSession()`,
  `assertOnline()`, `toast()`, `escapeHtml()`, `escapeAttr()` — todos ya definidos.
- Produces: `#producto-stock-row`, `#producto-stock-almacenes-row`,
  `#producto-stock-almacenes-list`, `#producto-entrada-row`, `#producto-entrada-cantidad`,
  `#producto-entrada-confirmar`, `#producto-entrada-error` — nuevos IDs.

- [ ] **Step 1: `loadProductos()` — total de stock vía join con `stock_almacen`**

En `app.js`, reemplazar (líneas 353-367):

```js
async function loadProductos() {
  const { data, error } = await supabase
    .from('productos')
    .select('id, nombre, precio, costo, foto_url, stock, categoria')
    .order('nombre');

  if (error) {
    toast('No se pudo cargar el inventario.', 'error');
    return;
  }

  productosCache = data || [];
  renderFiltrosCategoria();
  renderProductosGrid();
}
```

por:

```js
async function loadProductos() {
  const { data, error } = await supabase
    .from('productos')
    .select('id, nombre, precio, costo, foto_url, categoria, stock_almacen(cantidad)')
    .order('nombre');

  if (error) {
    toast('No se pudo cargar el inventario.', 'error');
    return;
  }

  productosCache = (data || []).map((p) => ({
    ...p,
    stock: (p.stock_almacen || []).reduce((sum, row) => sum + row.cantidad, 0),
  }));
  renderFiltrosCategoria();
  renderProductosGrid();
}
```

`renderProductosGrid()` (línea 394-429) no cambia — sigue leyendo `p.stock`, que ahora es
el total calculado en vez de la columna eliminada.

- [ ] **Step 2: Ocultar el campo Stock en modo edición, mostrarlo solo en alta**

En `index.html`, envolver el campo de stock existente (líneas 221-224) con un `id` nuevo:

```html
      <div class="field" id="producto-stock-row">
        <label for="producto-stock">Stock inicial</label>
        <input id="producto-stock" type="number" step="1" min="0" placeholder="0" />
      </div>
```

En `app.js`, en `openProductoForm()` (líneas 431-453), reemplazar la línea:

```js
  document.getElementById('producto-stock').value = producto ? producto.stock : '';
```

por:

```js
  document.getElementById('producto-stock-row').style.display = producto ? 'none' : 'block';
  document.getElementById('producto-stock').value = producto ? '' : '';
```

Y al final de la misma función, justo antes de
`document.getElementById('producto-sheet').classList.add('show');`, agregar:

```js
  document.getElementById('producto-stock-almacenes-row').style.display = producto ? 'block' : 'none';
  document.getElementById('producto-entrada-row').style.display =
    producto && getSession().rol === 'admin' ? 'block' : 'none';
  document.getElementById('producto-entrada-cantidad').value = '';
  document.getElementById('producto-entrada-error').textContent = '';
  if (producto) loadStockPorAlmacen(producto.id);
```

- [ ] **Step 3: Agregar la sección "Stock por almacén" y "Registrar entrada" en el HTML**

En `index.html`, después del campo `producto-categoria` (línea 228) y antes del campo
`producto-foto` (línea 229-233):

```html
      <div class="field" id="producto-stock-almacenes-row" style="display:none;">
        <label>Stock por almacén</label>
        <div id="producto-stock-almacenes-list" class="list"></div>
      </div>

      <div class="field" id="producto-entrada-row" style="display:none;">
        <label for="producto-entrada-cantidad">Registrar entrada (siempre a Central)</label>
        <input id="producto-entrada-cantidad" type="number" step="1" min="1" placeholder="Cantidad" />
        <button id="producto-entrada-confirmar" type="button" class="btn btn-outline">
          Registrar entrada
        </button>
        <p id="producto-entrada-error" class="error-msg"></p>
      </div>
```

- [ ] **Step 4: `loadStockPorAlmacen()` / `renderStockPorAlmacen()` — lista de solo lectura**

Insertar en `app.js`, después de `renderProductosGrid()` (línea 429) y antes de
`openProductoForm()`:

```js
async function loadStockPorAlmacen(productoId) {
  const [{ data: almacenes, error: almError }, { data: stock, error: stockError }] = await Promise.all([
    supabase.from('almacenes').select('id, nombre, usuario_id').order('nombre'),
    supabase.from('stock_almacen').select('almacen_id, cantidad').eq('producto_id', productoId),
  ]);

  if (almError || stockError) {
    document.getElementById('producto-stock-almacenes-list').innerHTML =
      '<p class="tab-placeholder">No se pudo cargar el stock por almacén.</p>';
    return;
  }

  const cantidadPorAlmacen = new Map((stock || []).map((s) => [s.almacen_id, s.cantidad]));
  renderStockPorAlmacen(almacenes || [], cantidadPorAlmacen);
}

function renderStockPorAlmacen(almacenes, cantidadPorAlmacen) {
  const list = document.getElementById('producto-stock-almacenes-list');
  list.innerHTML = '';

  almacenes.forEach((a) => {
    const cantidad = cantidadPorAlmacen.get(a.id) || 0;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(a.nombre)}</div>
      </div>
      <div class="li-badge ${cantidad > 0 ? 'al-dia' : 'pendiente'}">${cantidad}</div>
    `;
    list.appendChild(item);
  });
}
```

- [ ] **Step 5: `registrarEntradaProducto()` — botón "Registrar entrada"**

Insertar después de `renderStockPorAlmacen()`:

```js
async function registrarEntradaProducto() {
  if (!assertOnline()) return;
  if (!productoEditId) return;

  const cantidad = parseInt(document.getElementById('producto-entrada-cantidad').value, 10);
  const errorEl = document.getElementById('producto-entrada-error');
  const btn = document.getElementById('producto-entrada-confirmar');

  errorEl.textContent = '';

  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    errorEl.textContent = 'La cantidad debe ser un número entero mayor a 0.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Registrando...';

  try {
    const session = getSession();
    const { error } = await supabase.rpc('registrar_entrada', {
      p_producto_id: productoEditId,
      p_cantidad: cantidad,
      p_usuario_id: session.id,
    });

    if (error) {
      errorEl.textContent = 'No se pudo registrar la entrada. Intenta de nuevo.';
      return;
    }

    document.getElementById('producto-entrada-cantidad').value = '';
    toast('Entrada registrada.');
    loadStockPorAlmacen(productoEditId);
    loadProductos();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar entrada';
  }
}
```

- [ ] **Step 6: `saveProducto()` — usar `crear_producto()` en el alta**

En `app.js`, reemplazar el bloque de alta dentro de `saveProducto()` (líneas 506-530):

```js
  try {
    let fotoUrl = productoFotoUrlActual;

    if (file) {
      const path = `${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from('productos').upload(path, file);
      if (uploadError) {
        errorEl.textContent = 'No se pudo subir la foto. Intenta de nuevo.';
        return;
      }
      const { data: urlData } = supabase.storage.from('productos').getPublicUrl(path);
      fotoUrl = urlData.publicUrl;
    }

    const payload = { nombre, precio, costo, stock, categoria: categoria || null, foto_url: fotoUrl };
    const query = productoEditId
      ? supabase.from('productos').update(payload).eq('id', productoEditId)
      : supabase.from('productos').insert(payload);

    const { error } = await query;

    if (error) {
      errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
      return;
    }

    closeProductoForm();
    toast(productoEditId ? 'Producto actualizado.' : 'Producto agregado.');
    loadProductos();
  } finally {
```

por:

```js
  try {
    let fotoUrl = productoFotoUrlActual;

    if (file) {
      const path = `${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from('productos').upload(path, file);
      if (uploadError) {
        errorEl.textContent = 'No se pudo subir la foto. Intenta de nuevo.';
        return;
      }
      const { data: urlData } = supabase.storage.from('productos').getPublicUrl(path);
      fotoUrl = urlData.publicUrl;
    }

    if (productoEditId) {
      const payload = { nombre, precio, costo, categoria: categoria || null, foto_url: fotoUrl };
      const { error } = await supabase.from('productos').update(payload).eq('id', productoEditId);

      if (error) {
        errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
        return;
      }
    } else {
      const session = getSession();
      const { error } = await supabase.rpc('crear_producto', {
        p_nombre: nombre,
        p_precio: precio,
        p_costo: costo,
        p_foto_url: fotoUrl,
        p_categoria: categoria || null,
        p_stock_inicial: stock,
        p_usuario_id: session.id,
      });

      if (error) {
        errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
        return;
      }
    }

    closeProductoForm();
    toast(productoEditId ? 'Producto actualizado.' : 'Producto agregado.');
    loadProductos();
  } finally {
```

Nota: `stock` en modo edición ya no se valida contra el input oculto — el bloque de
validación existente (líneas 494-497, `!Number.isInteger(stock) || stock < 0`) solo debe
aplicar en modo alta. Ajustar ese bloque:

```js
  if (!productoEditId && (!Number.isInteger(stock) || stock < 0)) {
    errorEl.textContent = 'El stock inicial es obligatorio y debe ser un número entero, 0 o mayor.';
    return;
  }
```

(reemplaza la validación existente en líneas 494-497; en modo edición `stock` ya viene
`NaN` porque el input está vacío, y con este cambio ya no bloquea el guardado).

- [ ] **Step 7: Cablear el botón nuevo en `initInventario()`**

En `app.js`, `initInventario()` (líneas 541-546), agregar:

```js
  document.getElementById('producto-entrada-confirmar').addEventListener('click', registrarEntradaProducto);
```

- [ ] **Step 8: Estilos nuevos al final de `styles.css`**

```css
/* ---------- Inventario multi-almacén ---------- */

#producto-stock-almacenes-list .list-item,
#producto-entrada-row {
  margin-top: 4px;
}
```

- [ ] **Step 9: Verificar en el navegador — alta de producto con stock inicial**

Entrar como "Papá", ir a Inventario, tocar "+", llenar un producto nuevo con stock inicial
15, guardar.

Expected: toast "Producto agregado.", la tarjeta muestra "Stock: 15". Abrir "Movimientos"
(una vez completada la Task 12) debe mostrar la entrada — de momento, verificar
directamente en Supabase con `select * from movimientos_almacen order by creado_en desc
limit 1;` que quedó un movimiento de entrada a Central por 15.

- [ ] **Step 10: Verificar edición — stock desaparece, aparece "Stock por almacén"**

Tocar la tarjeta del producto recién creado.

Expected: el campo "Stock inicial" ya no aparece; en su lugar se ve "Stock por almacén"
con una fila por cada almacén existente (Central con 15, cada usuario con 0), y (si el
usuario logueado es admin) el mini-formulario "Registrar entrada".

- [ ] **Step 11: Verificar "Registrar entrada"**

Con el panel de edición abierto, escribir 5 en el campo de entrada, tocar "Registrar
entrada".

Expected: toast "Entrada registrada.", la fila de Central en "Stock por almacén" sube a
20 sin recargar la página manualmente, y la tarjeta en la grilla de Inventario (al cerrar
el formulario) muestra "Stock: 20".

- [ ] **Step 12: Verificar que un vendedor no ve el mini-formulario de entrada**

Cerrar sesión, entrar como "Angie", abrir el mismo producto en edición.

Expected: se ve "Stock por almacén" (transparencia), pero no aparece el mini-formulario
"Registrar entrada".

---

### Task 11: Frontend Carrito de venta — solo lo que el vendedor trae en su propio almacén

**Files:**
- Modify: `app.js:644-677` (`openVentaPanel()` — cambiar la consulta de productos)

**Interfaces:**
- Consumes: `stock_almacen` (Task 1), `session.almacenId` (Task 9).
- Produces: `ventaProductosCache` sigue con la misma forma (`{id, nombre, precio, costo,
  stock}`) que ya consumen `renderVentaProductos()` (línea 688) y `addToCarrito()` (línea
  711) — esas dos funciones no cambian.

- [ ] **Step 1: Cambiar la consulta de productos disponibles al almacén propio**

En `app.js`, dentro de `openVentaPanel()`, reemplazar (línea 652-655):

```js
  const [{ data: productos, error: prodError }, { data: clientes, error: cliError }] = await Promise.all([
    supabase.from('productos').select('id, nombre, precio, stock, costo').order('nombre'),
    supabase.from('clientes').select('id, nombre').order('nombre'),
  ]);

  if (prodError || cliError) {
    toast('No se pudo cargar productos/clientes.', 'error');
    return;
  }

  ventaProductosCache = productos || [];
```

por:

```js
  const session = getSession();
  const [{ data: productos, error: prodError }, { data: clientes, error: cliError }] = await Promise.all([
    supabase
      .from('productos')
      .select('id, nombre, precio, costo, stock_almacen!inner(cantidad)')
      .eq('stock_almacen.almacen_id', session.almacenId)
      .order('nombre'),
    supabase.from('clientes').select('id, nombre').order('nombre'),
  ]);

  if (prodError || cliError) {
    toast('No se pudo cargar productos/clientes.', 'error');
    return;
  }

  ventaProductosCache = (productos || []).map((p) => ({
    ...p,
    stock: p.stock_almacen[0]?.cantidad ?? 0,
  }));
```

Un producto sin fila en `stock_almacen` para el almacén del vendedor logueado no aparece
en absoluto (el `!inner` join lo excluye) — correcto según spec: "nunca le han
traspasado nada" equivale a no estar disponible para vender.

`renderVentaProductos()` (línea 688) y `addToCarrito()` (línea 711) siguen leyendo
`p.stock` tal cual, sin más cambios.

- [ ] **Step 2: Verificar en el navegador — Angie solo ve lo que tiene en su almacén**

Como admin, usar la pantalla de Inventario (Task 10) o Supabase directo para traspasar 5
unidades de "Playera polo azul" de Central a Angie. Cerrar sesión, entrar como Angie,
abrir "Nueva venta".

Expected: "Playera polo azul" aparece en "Productos disponibles" con "Stock disponible:
5". Agregar las 5 al carrito → el producto pasa a mostrarse deshabilitado ("Stock
disponible: 0"). Intentar agregar una unidad más (tocar de nuevo) → no agrega nada
(bloqueado en el propio `addToCarrito()`, sin cambios de este ticket).

- [ ] **Step 3: Verificar que otro vendedor sin ese producto en su almacén no lo ve**

Entrar como "Alexis" (sin nada de "Playera polo azul" traspasado a su almacén) y abrir
"Nueva venta".

Expected: "Playera polo azul" no aparece en la lista de "Productos disponibles" en
absoluto (aunque Central y Angie sí tengan unidades).

- [ ] **Step 4: Regresión — confirmar venta y que descuenta el almacén correcto**

Como Angie, vender 2 unidades de "Playera polo azul".

Expected: la venta se confirma igual que siempre (recibo, folio, etc. — sin cambios
visuales); al reabrir "Nueva venta" como Angie, "Stock disponible" bajó a 3. Verificar en
Supabase que `stock_almacen` de Angie (no Central) bajó esas 2 unidades (ya cubierto en
Task 6, aquí solo se confirma que el frontend refleja el número correcto).

---

### Task 12: Frontend — pantalla nueva "📦 Movimientos"

**Files:**
- Modify: `index.html:57-71` (agregar botón de acceso rápido "📦 Movimientos" en Inicio)
- Modify: `index.html` (agregar el panel `#movimientos-panel` después de `#cuenta-panel`,
  línea 431, y antes de `<div id="toast">`, línea 433; agregar el bottom sheet
  `#movimiento-sheet` después de `#usuario-sheet`, línea 274)
- Modify: `app.js` (agregar sección nueva "Movimientos" después de la sección "Mi cuenta" —
  después de `saveUsuario()` y antes de `// ---------- Init ----------`)
- Modify: `app.js:1742-1752` (`init()` — agregar `initMovimientos();`)
- Modify: `styles.css` (agregar estilos nuevos al final)

**Interfaces:**
- Consumes: `registrar_entrada()` (Task 3), `registrar_traspaso()` (Task 4),
  `anular_movimiento()` (Task 5), `getSession()`, `assertOnline()`, `toast()`,
  `escapeHtml()`, `fechaFmt`, `money` — todos ya definidos o de tasks anteriores.
- Produces: `openMovimientosPanel()`, `closeMovimientosPanel()`, `initMovimientos()`.

- [ ] **Step 1: Botón de acceso rápido en Inicio**

En `index.html`, después del botón `#btn-historial` (líneas 68-71):

```html
        <button id="btn-movimientos" class="quick-action quick-action-outline">
          <span class="quick-action-icon">📦</span>
          Movimientos
        </button>
```

- [ ] **Step 2: Panel `#movimientos-panel` (fullscreen)**

En `index.html`, después de `#cuenta-panel` (línea 431) y antes de `<div
id="toast"></div>` (línea 433):

```html
  <!-- ============ Panel Movimientos (fullscreen) ============ -->
  <div id="movimientos-panel" class="fullscreen-overlay">
    <div class="fs-header">
      <button id="movimientos-cerrar" class="icon-btn" type="button">✕</button>
      <h3>Movimientos</h3>
      <span style="width:32px"></span>
    </div>

    <div class="fs-content">
      <div id="movimientos-list" class="list"></div>
      <p id="movimientos-empty" class="tab-placeholder" style="display:none;">
        Aún no hay movimientos de almacén registrados.
      </p>
    </div>

    <button id="fab-nuevo-movimiento" class="fab" type="button">+</button>
  </div>
```

- [ ] **Step 3: Bottom sheet `#movimiento-sheet`**

En `index.html`, después de `#usuario-sheet` (línea 274):

```html
  <!-- ============ Formulario movimiento (bottom sheet) ============ -->
  <div id="movimiento-sheet" class="sheet-overlay">
    <div class="sheet">
      <h3>Nuevo movimiento</h3>
      <div class="field">
        <label>Tipo</label>
        <div class="toggle-group" id="movimiento-tipo-toggle">
          <button type="button" class="toggle-btn active" data-tipo="entrada">Entrada</button>
          <button type="button" class="toggle-btn" data-tipo="traspaso">Traspaso</button>
        </div>
      </div>
      <div class="field">
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
      <div class="field">
        <label for="movimiento-cantidad">Cantidad</label>
        <input id="movimiento-cantidad" type="number" step="1" min="1" placeholder="0" />
      </div>
      <p id="movimiento-form-error" class="error-msg"></p>
      <div class="sheet-actions">
        <button id="movimiento-cancelar" type="button" class="btn btn-outline">Cancelar</button>
        <button id="movimiento-guardar" type="button" class="btn btn-primary">Guardar</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Sección "Movimientos" en `app.js` — estado, carga y render de la lista**

Insertar en `app.js`, después de `saveUsuario()` (después de la línea que hoy es el cierre
de esa función, justo antes de `// ---------- Init ----------`):

```js
// ---------- Movimientos ----------

let movimientosCache = [];
let almacenesCache = [];
let productosParaMovimientoCache = [];

async function loadAlmacenes() {
  const { data, error } = await supabase
    .from('almacenes')
    .select('id, nombre, usuario_id')
    .order('nombre');
  almacenesCache = error ? [] : (data || []);
}

async function loadMovimientos() {
  const { data, error } = await supabase
    .from('movimientos_almacen')
    .select(`
      id, cantidad, creado_en, anulado, anulado_en,
      producto:productos(nombre),
      origen:almacenes!movimientos_almacen_almacen_origen_id_fkey(nombre),
      destino:almacenes!movimientos_almacen_almacen_destino_id_fkey(nombre),
      usuario:usuarios!movimientos_almacen_usuario_id_fkey(nombre),
      anulador:usuarios!movimientos_almacen_anulado_por_fkey(nombre)
    `)
    .order('creado_en', { ascending: false })
    .limit(200);

  if (error) {
    toast('No se pudo cargar los movimientos.', 'error');
    movimientosCache = [];
    renderMovimientos();
    return;
  }

  movimientosCache = data || [];
  renderMovimientos();
}

function renderMovimientos() {
  const list = document.getElementById('movimientos-list');
  const empty = document.getElementById('movimientos-empty');
  const session = getSession();

  list.innerHTML = '';
  empty.style.display = movimientosCache.length === 0 ? 'block' : 'none';

  movimientosCache.forEach((m) => {
    const descripcion = m.origen
      ? `Traspaso: ${escapeHtml(m.origen.nombre)} → ${escapeHtml(m.destino.nombre)}`
      : `Entrada → ${escapeHtml(m.destino.nombre)}`;

    const anuladoTag = m.anulado
      ? '<div class="li-sub historial-anulado-tag">Anulado</div>'
      : '';

    const card = document.createElement('div');
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

async function confirmarAnularMovimiento(movimientoId, btn) {
  if (!assertOnline()) return;

  const ok = window.confirm('¿Seguro que quieres anular este movimiento? No se puede deshacer.');
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Anulando...';

  try {
    const session = getSession();
    const { error } = await supabase.rpc('anular_movimiento', {
      p_movimiento_id: movimientoId,
      p_usuario_id: session.id,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('STOCK_INSUFICIENTE_PARA_ANULAR')) {
        toast('No se puede anular: esas unidades ya se movieron o vendieron desde entonces.', 'error');
      } else if (msg.includes('YA_ANULADO')) {
        toast('Este movimiento ya estaba anulado.', 'error');
      } else if (msg.includes('PERMISO_DENEGADO')) {
        toast('No tienes permiso para anular movimientos.', 'error');
      } else {
        toast('No se pudo anular. Intenta de nuevo.', 'error');
      }
      return;
    }

    toast('Movimiento anulado.');
    loadMovimientos();
    loadProductos();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anular';
  }
}
```

- [ ] **Step 5: Abrir/cerrar el panel**

Insertar después de `renderMovimientos()`/`confirmarAnularMovimiento()`:

```js
async function openMovimientosPanel() {
  const session = getSession();
  document.getElementById('fab-nuevo-movimiento').classList.toggle('show', session.rol === 'admin');
  document.getElementById('movimientos-panel').classList.add('show');
  await loadMovimientos();
}

function closeMovimientosPanel() {
  document.getElementById('movimientos-panel').classList.remove('show');
}
```

- [ ] **Step 6: Formulario de alta — toggle Entrada/Traspaso, poblar selects**

Insertar después de `closeMovimientosPanel()`:

```js
async function openMovimientoForm() {
  document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tipo === 'entrada');
  });
  document.getElementById('movimiento-origen-row').style.display = 'none';
  document.getElementById('movimiento-destino-row').style.display = 'none';
  document.getElementById('movimiento-cantidad').value = '';
  document.getElementById('movimiento-form-error').textContent = '';

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
      opt.textContent = a.usuario_id ? a.nombre : 'Central';
      select.appendChild(opt);
    });
  });

  document.getElementById('movimiento-sheet').classList.add('show');
}

function closeMovimientoForm() {
  document.getElementById('movimiento-sheet').classList.remove('show');
}
```

`almacenesCache` ya trae `nombre` (que para el almacén de cada usuario se sembró igual al
`nombre` del usuario en la Task 1 — `insert into almacenes (nombre, usuario_id) select
nombre, id from usuarios` — y en `crear_usuario()` desde la Task 8), así que `a.nombre`
alcanza para mostrar algo legible sin otro join.

- [ ] **Step 7: Guardar — llamar `registrar_entrada()` o `registrar_traspaso()`**

Insertar después de `closeMovimientoForm()`:

```js
async function guardarMovimiento() {
  if (!assertOnline()) return;

  const tipo = document.querySelector('#movimiento-tipo-toggle .toggle-btn.active').dataset.tipo;
  const productoId = document.getElementById('movimiento-producto').value;
  const cantidad = parseInt(document.getElementById('movimiento-cantidad').value, 10);
  const errorEl = document.getElementById('movimiento-form-error');
  const btn = document.getElementById('movimiento-guardar');

  errorEl.textContent = '';

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
        errorEl.textContent = 'No se pudo registrar la entrada. Intenta de nuevo.';
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
    loadProductos();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}
```

- [ ] **Step 8: `initMovimientos()` — cablear todo, incluidos los toggles y el FAB**

Insertar después de `guardarMovimiento()`:

```js
function initMovimientos() {
  document.getElementById('btn-movimientos').addEventListener('click', openMovimientosPanel);
  document.getElementById('movimientos-cerrar').addEventListener('click', closeMovimientosPanel);
  document.getElementById('fab-nuevo-movimiento').addEventListener('click', openMovimientoForm);
  document.getElementById('movimiento-cancelar').addEventListener('click', closeMovimientoForm);
  document.getElementById('movimiento-guardar').addEventListener('click', guardarMovimiento);

  document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const esTraspaso = btn.dataset.tipo === 'traspaso';
      document.getElementById('movimiento-origen-row').style.display = esTraspaso ? 'block' : 'none';
      document.getElementById('movimiento-destino-row').style.display = esTraspaso ? 'block' : 'none';
    });
  });
}
```

En `init()` (línea ~1752), agregar junto a las demás `init*`:

```js
  initMovimientos();
```

- [ ] **Step 9: Estilos nuevos al final de `styles.css`**

Los estilos ya existentes (`.fullscreen-overlay`, `.fs-header`, `.fs-content`, `.list`,
`.list-item`, `.historial-item`, `.historial-item.anulado`, `.sheet-overlay`, `.sheet`,
`.toggle-group`, `.fab`, `.quick-action-outline`) cubren todo el panel sin necesidad de
CSS nuevo — no se agrega ninguna regla en este step. (Si al verificar visualmente algo se
ve mal alineado, es un ajuste puntual a resolver en el momento, no algo previsible desde
este plan.)

- [ ] **Step 10: Verificar en el navegador — ver el historial de movimientos**

Entrar como cualquier usuario (incluido un vendedor), tocar "📦 Movimientos" en Inicio.

Expected: se abre el panel con la lista completa de movimientos ya generados por las
Tasks 2-5/10 más los reales del negocio, ordenados del más reciente al más antiguo, cada
uno mostrando producto, tipo (Entrada/Traspaso con nombres de almacén), cantidad, quién lo
registró y fecha. Un vendedor no ve el botón (+) ni "Anular" en ninguna fila; un admin sí
ve ambos.

- [ ] **Step 11: Verificar alta de entrada desde la UI**

Como "Papá", tocar (+), dejar el toggle en "Entrada", elegir "Playera polo azul",
cantidad 3, guardar.

Expected: toast "Entrada registrada.", aparece arriba de la lista un nuevo renglón
"Playera polo azul · Entrada → Central", 3 unidades, "Papá", fecha de hoy.

- [ ] **Step 12: Verificar alta de traspaso y anulación desde la UI**

Tocar (+), cambiar a "Traspaso", elegir el mismo producto, origen "Central", destino
"Angie" (o el nombre real del vendedor), cantidad 2, guardar. Confirmar que aparece en la
lista. Tocar "Anular" en ese mismo renglón recién creado, confirmar el diálogo.

Expected: toast "Movimiento anulado.", la fila pasa a mostrar la etiqueta "Anulado" y ya
no tiene botón "Anular". Repetir "Registrar entrada" (Task 10) o abrir el mismo producto
en Inventario para confirmar que Central recuperó las 2 unidades.

---

### Task 13: Limpieza de datos de prueba, regresión completa y cierre del ticket

**Files:**
- Modify: `sw.js:1` (`CACHE = 'vf-v5'` → `'vf-v6'`)
- Modify: `TICKETS.md` (marcar el ticket 13 con los checkboxes completados y el bloque
  "Estado", mismo formato que los tickets 01-12)
- Modify: `CLAUDE.md` (mover el ticket 13 de "Pendiente" a "Completados" en la sección
  "Progreso")

**Interfaces:**
- Consumes: ninguna nueva — este task es de verificación, limpieza y documentación.
- Produces: `sw.js`, `TICKETS.md`, `CLAUDE.md` actualizados.

- [ ] **Step 1: Confirmar que no quedó ningún dato de prueba**

```sql
select nombre from productos where nombre like 'Test %';
-- Esperado: 0 filas — si aparece alguno, eliminarlo:
delete from movimientos_almacen where producto_id in (select id from productos where nombre like 'Test %');
delete from stock_almacen where producto_id in (select id from productos where nombre like 'Test %');
delete from productos where nombre like 'Test %';

select nombre from usuarios where nombre like 'Test %';
-- Esperado: 0 filas — si aparece alguno:
delete from almacenes where usuario_id in (select id from usuarios where nombre like 'Test %');
delete from usuarios where nombre like 'Test %';
```

- [ ] **Step 2: Confirmar que el stock del producto real quedó como al inicio del ticket**

```sql
select a.nombre, coalesce(u.nombre, 'Central') as dueno, sa.cantidad
from stock_almacen sa
join almacenes a on a.id = sa.almacen_id
left join usuarios u on u.id = a.usuario_id
join productos p on p.id = sa.producto_id
where sa.cantidad > 0
order by p.nombre, dueno;
```

Comparar contra lo anotado en la Task 1, Step 1. Si algún traspaso de prueba quedó sin
revertir (a pesar de los steps de limpieza de cada task), corregirlo ahora con
`registrar_traspaso()` directo hasta que coincida con el estado real del negocio — o, si
Luis ya empezó a repartir stock de verdad durante las pruebas, dejarlo como esté y avisarle
explícitamente qué cambió respecto al inicio.

- [ ] **Step 3: Bump de caché en `sw.js`**

```js
const CACHE = 'vf-v6';
```

- [ ] **Step 4: Regresión rápida sobre los módulos existentes**

Repetir brevemente los flujos ya cubiertos por tickets anteriores: login, venta de
contado, venta a crédito, abono, anular venta/abono, historial, reportes, gestión de
usuarios (ticket 12). Expected: sin regresiones — todos funcionan igual que antes, salvo
que el stock disponible que ve cada vendedor ahora es el de su propio almacén (cambio
esperado de este ticket).

- [ ] **Step 5: Actualizar `TICKETS.md`**

Reemplazar el bloque del ticket 13 (buscar `## 13` en el archivo) por:

```markdown
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

- [x] Esquema: `almacenes`, `stock_almacen`, `movimientos_almacen`
- [x] `registrar_entrada()`, `registrar_traspaso()`, `anular_movimiento()`
- [x] `crear_producto()` (alta con stock inicial atómico, ya no insert directo)
- [x] Rework de `registrar_venta()`/`anular_venta()` (almacén del vendedor)
- [x] Inventario: stock por almacén (solo lectura) + botón "Registrar entrada"
- [x] Carrito de venta: lista solo lo que el vendedor trae en su propio almacén
- [x] Pantalla nueva "📦 Movimientos" con permisos admin/todos
```

- [ ] **Step 6: Actualizar la sección "Progreso" de `CLAUDE.md`**

Reemplazar:

```markdown
Completados: 01 (esquema Supabase), 02 (shell + login), 03 (Clientes), 04 (Inventario),
05 (venta de contado), 06 (venta a crédito), 07 (Abonos), 08 (Anulaciones), 09 (recibos
PDF/WhatsApp), 10 (Dashboard principal), 11 (Reportes + ganancia neta por vendedor),
12 (Gestión de usuarios — SQL probado en vivo, frontend verificado de forma estática,
pendiente prueba manual de Luis en el navegador).

**Pendiente:**
- 13 (Inventario multi-almacén) — ya **no bloqueado** (el ticket 12 quedó completo), pero
  sigue esperando revisión final de Luis antes de pasar a plan de implementación. Spec en
  [docs/superpowers/specs/2026-07-30-multi-almacen-design.md](docs/superpowers/specs/2026-07-30-multi-almacen-design.md).

Los usuarios y roles fijos descritos abajo ("Usuarios y roles") dejaron de ser fijos con
el ticket 12 — ahora son altas/bajas dinámicas desde la app (sección "Mi cuenta").
```

por:

```markdown
Completados: 01 (esquema Supabase), 02 (shell + login), 03 (Clientes), 04 (Inventario),
05 (venta de contado), 06 (venta a crédito), 07 (Abonos), 08 (Anulaciones), 09 (recibos
PDF/WhatsApp), 10 (Dashboard principal), 11 (Reportes + ganancia neta por vendedor),
12 (Gestión de usuarios), 13 (Inventario multi-almacén — stock distribuido por almacén,
pantalla "Movimientos", ver [docs/superpowers/specs/2026-07-30-multi-almacen-design.md](docs/superpowers/specs/2026-07-30-multi-almacen-design.md)
para el diseño completo).

**Pendiente:** ninguno de los tickets 01-13. Próximos pasos por definir con Luis.

Los usuarios y roles fijos descritos abajo ("Usuarios y roles") dejaron de ser fijos con
el ticket 12 — ahora son altas/bajas dinámicas desde la app (sección "Mi cuenta"). El
stock descrito en "Archivos del proyecto"/`app.js` ya no es un total único por producto —
está distribuido en almacenes (ticket 13); ver la pantalla "Movimientos" para el
historial completo.
```

- [ ] **Step 7: Confirmar el resultado leyendo los archivos**

Releer `TICKETS.md` y `CLAUDE.md` completos y confirmar que el ticket 13 quedó con el
mismo formato visual (✅ en el título, bloque **Estado**, checkboxes marcados) que los
tickets anteriores.

- [ ] **Step 8: Subir los cambios**

```powershell
cd "C:\Users\DELL\Documents\IA-Claude- Proyecto MPM\PWA - Aplicaciones\Ventas Familia"
git add -A
git commit -m "Ticket 13: Inventario multi-almacén — stock distribuido, movimientos y traspasos"
git push
```
