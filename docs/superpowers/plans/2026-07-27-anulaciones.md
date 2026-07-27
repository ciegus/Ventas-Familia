# Ticket 08 — Anulaciones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir anular ventas y abonos (nunca borrado físico), con reversión correcta de stock/saldo y permisos por rol, expuestos a través de una nueva pantalla Historial.

**Architecture:** Dos funciones SQL `SECURITY DEFINER` nuevas en Supabase (`anular_venta`, `anular_abono`) que hacen la reversión atómica server-side. Una pantalla Historial nueva (panel fullscreen, mismo patrón que Venta/Abono) que lista ventas+abonos combinados y expone el botón Anular condicionado por permiso.

**Tech Stack:** HTML/CSS/JS vanilla (sin build step, `<script type="module">`), Supabase JS v2 (`@supabase/supabase-js`), Postgres/plpgsql en Supabase (proyecto `ventas-familia`, ref `wiewxgkiefsjeonirsid`).

## Global Constraints

- Nunca se borra un registro físicamente — se marca `anulado`, `anulado_por`, `anulado_en` (SPEC sección 6).
- Un vendedor solo anula lo suyo; el rol `admin` anula cualquier registro (SPEC sección 6).
- Ninguna operación de escritura debe fallar en silencio ni encolarse sin conexión — usar `assertOnline()` antes de cualquier RPC de escritura (patrón ya establecido en `app.js`).
- La barra de navegación inferior queda fija en 4 pestañas (Inicio/Inventario/Clientes/Reportes) — Historial se agrega como acción rápida en Inicio, no como pestaña (SPEC sección 10).
- No se agregan dependencias nuevas ni build step — todo el código sigue siendo HTML/CSS/JS plano cargado directo por el navegador.
- Seguir la paleta y componentes visuales ya definidos en `styles.css` (`.fullscreen-overlay`, `.list-item`, `.chip`, `.quick-action`, variables `--accent`/`--navy`/`--error`/etc.) — no introducir un sistema visual paralelo.
- Las funciones SQL siguen el estilo ya establecido por `registrar_venta`/`registrar_abono`: `plpgsql`, `SECURITY DEFINER`, `SET search_path TO 'public'`, errores de negocio comunicados con `RAISE EXCEPTION '<CODIGO_EN_MAYUSCULAS>'` que el cliente detecta con `error.message.includes(...)`.
- No hay framework de pruebas automatizadas en este proyecto — la verificación de cada tarea es manual: SQL directo contra Supabase (para las funciones) y navegador (para la UI), documentando el resultado igual que en los tickets 01-07 de `TICKETS.md`.

---

### Task 1: Función SQL `anular_abono`

**Files:**
- Supabase (proyecto `wiewxgkiefsjeonirsid`), vía migración `apply_migration` con nombre `anular_abono`. No hay archivo `.sql` local — el proyecto no versiona migraciones en el repo (ver ticket 01 de TICKETS.md, el esquema vive solo en Supabase).

**Interfaces:**
- Consumes: tablas `abonos` (`id, folio, cliente_id, vendedor_id, monto, anulado, anulado_por, anulado_en`), `clientes` (`id, saldo_pendiente`), `usuarios` (`id, rol`) — ya existentes, sin cambios de esquema.
- Produces: `anular_abono(p_abono_id uuid, p_usuario_id uuid) RETURNS TABLE(folio text)`, consumida por Task 5 desde `app.js` vía `supabase.rpc('anular_abono', { p_abono_id, p_usuario_id })`. Errores de negocio: `NO_ENCONTRADO`, `YA_ANULADO`, `PERMISO_DENEGADO`.

- [ ] **Step 1: Aplicar la migración con la función**

Ejecutar con la tool `apply_migration` (`project_id: wiewxgkiefsjeonirsid`, `name: anular_abono`):

```sql
create or replace function public.anular_abono(p_abono_id uuid, p_usuario_id uuid)
returns table(folio text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_folio text;
  v_cliente_id uuid;
  v_vendedor_id uuid;
  v_monto numeric;
  v_anulado boolean;
  v_rol text;
begin
  select folio, cliente_id, vendedor_id, monto, anulado
    into v_folio, v_cliente_id, v_vendedor_id, v_monto, v_anulado
    from abonos where id = p_abono_id for update;

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

  update clientes set saldo_pendiente = saldo_pendiente + v_monto where id = v_cliente_id;

  update abonos set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
    where id = p_abono_id;

  return query select v_folio;
end;
$function$;
```

- [ ] **Step 2: Verificar con datos reales usando `execute_sql`**

Sembrar un cliente y un vendedor de prueba, un abono, anularlo, y confirmar el resultado (ejecutar como una sola sesión de `execute_sql`, limpiar al final):

```sql
-- Setup
insert into clientes (id, nombre, saldo_pendiente) values
  ('00000000-0000-0000-0000-0000000000c1', 'Test Cliente Anulacion', 500)
on conflict (id) do nothing;

-- vendedor_id: usar un id real de la tabla usuarios (select id from usuarios where nombre = 'Angie' limit 1)
insert into abonos (id, folio, cliente_id, vendedor_id, monto)
values (
  '00000000-0000-0000-0000-0000000000a1',
  'REC-TESTAB01',
  '00000000-0000-0000-0000-0000000000c1',
  (select id from usuarios where nombre = 'Angie'),
  150
);

-- Ejercitar la función: debe regresar el folio y subir el saldo de 500 a 650
select * from anular_abono(
  '00000000-0000-0000-0000-0000000000a1',
  (select id from usuarios where nombre = 'Angie')
);

select saldo_pendiente from clientes where id = '00000000-0000-0000-0000-0000000000c1';
-- Esperado: 650

select anulado, anulado_por, anulado_en from abonos where id = '00000000-0000-0000-0000-0000000000a1';
-- Esperado: anulado=true, anulado_por = id de Angie, anulado_en no nulo

-- Doble anulación debe fallar con YA_ANULADO
select * from anular_abono(
  '00000000-0000-0000-0000-0000000000a1',
  (select id from usuarios where nombre = 'Angie')
);
-- Esperado: error "YA_ANULADO"

-- Cleanup
delete from abonos where id = '00000000-0000-0000-0000-0000000000a1';
delete from clientes where id = '00000000-0000-0000-0000-0000000000c1';
```

Expected: el primer `select * from anular_abono(...)` regresa una fila con `folio = 'REC-TESTAB01'`; el saldo del cliente queda en 650; el segundo intento lanza el error `YA_ANULADO`. Confirmar los tres resultados antes de continuar.

- [ ] **Step 3: Confirmar que no quedaron residuos de la prueba**

```sql
select count(*) from abonos where folio = 'REC-TESTAB01';
select count(*) from clientes where nombre = 'Test Cliente Anulacion';
```

Expected: ambos en `0`.

---

### Task 2: Función SQL `anular_venta`

**Files:**
- Supabase (proyecto `wiewxgkiefsjeonirsid`), vía `apply_migration` con nombre `anular_venta`.

**Interfaces:**
- Consumes: tablas `ventas` (`id, folio, tipo, cliente_id, vendedor_id, total, enganche, anulado, anulado_por, anulado_en`), `venta_items` (`venta_id, producto_id, cantidad`), `productos` (`id, stock`), `clientes` (`id, saldo_pendiente`), `usuarios` (`id, rol`) — sin cambios de esquema.
- Produces: `anular_venta(p_venta_id uuid, p_usuario_id uuid) RETURNS TABLE(folio text)`, consumida por Task 5. Errores de negocio: `NO_ENCONTRADO`, `YA_ANULADO`, `PERMISO_DENEGADO`, `SALDO_INSUFICIENTE_PARA_ANULAR`.

- [ ] **Step 1: Aplicar la migración con la función**

Ejecutar con `apply_migration` (`project_id: wiewxgkiefsjeonirsid`, `name: anular_venta`):

```sql
create or replace function public.anular_venta(p_venta_id uuid, p_usuario_id uuid)
returns table(folio text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_folio text;
  v_tipo text;
  v_cliente_id uuid;
  v_vendedor_id uuid;
  v_total numeric;
  v_enganche numeric;
  v_anulado boolean;
  v_rol text;
  v_pendiente numeric;
  v_saldo numeric;
  v_item record;
begin
  select folio, tipo, cliente_id, vendedor_id, total, enganche, anulado
    into v_folio, v_tipo, v_cliente_id, v_vendedor_id, v_total, v_enganche, v_anulado
    from ventas where id = p_venta_id for update;

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

  if v_tipo = 'credito' then
    v_pendiente := v_total - v_enganche;
    select saldo_pendiente into v_saldo from clientes where id = v_cliente_id for update;

    if v_saldo < v_pendiente then
      raise exception 'SALDO_INSUFICIENTE_PARA_ANULAR';
    end if;

    update clientes set saldo_pendiente = saldo_pendiente - v_pendiente where id = v_cliente_id;
  end if;

  for v_item in select producto_id, cantidad from venta_items where venta_id = p_venta_id
  loop
    update productos set stock = stock + v_item.cantidad where id = v_item.producto_id;
  end loop;

  update ventas set anulado = true, anulado_por = p_usuario_id, anulado_en = now()
    where id = p_venta_id;

  return query select v_folio;
end;
$function$;
```

- [ ] **Step 2: Verificar caso venta de contado (repone stock, no toca saldo) con `execute_sql`**

```sql
-- Setup: producto con stock 10, venta de contado de 3 unidades
insert into productos (id, nombre, precio, foto_url, stock)
values ('00000000-0000-0000-0000-0000000000p1', 'Test Producto Anulacion', 100, 'https://example.com/x.jpg', 10)
on conflict (id) do nothing;

insert into ventas (id, folio, tipo, vendedor_id, total)
values (
  '00000000-0000-0000-0000-0000000000v1',
  'REC-TESTVT01',
  'contado',
  (select id from usuarios where nombre = 'Angie'),
  300
);

insert into venta_items (venta_id, producto_id, cantidad, precio_unitario)
values ('00000000-0000-0000-0000-0000000000v1', '00000000-0000-0000-0000-0000000000p1', 3, 100);

update productos set stock = stock - 3 where id = '00000000-0000-0000-0000-0000000000p1';
-- stock ahora en 7

select * from anular_venta(
  '00000000-0000-0000-0000-0000000000v1',
  (select id from usuarios where nombre = 'Angie')
);

select stock from productos where id = '00000000-0000-0000-0000-0000000000p1';
-- Esperado: 10 (repuesto)
```

Expected: la función regresa `folio = 'REC-TESTVT01'`; el stock vuelve a `10`.

- [ ] **Step 3: Verificar caso venta a crédito con saldo suficiente (repone stock y resta saldo)**

```sql
insert into clientes (id, nombre, saldo_pendiente)
values ('00000000-0000-0000-0000-0000000000c2', 'Test Cliente Credito', 700)
on conflict (id) do nothing;

insert into ventas (id, folio, tipo, cliente_id, vendedor_id, total, enganche)
values (
  '00000000-0000-0000-0000-0000000000v2',
  'REC-TESTVT02',
  'credito',
  '00000000-0000-0000-0000-0000000000c2',
  (select id from usuarios where nombre = 'Angie'),
  1000,
  300
);
-- saldo_pendiente del cliente ya incluye los 700 de esta venta (total - enganche)

insert into venta_items (venta_id, producto_id, cantidad, precio_unitario)
values ('00000000-0000-0000-0000-0000000000v2', '00000000-0000-0000-0000-0000000000p1', 2, 100);

update productos set stock = stock - 2 where id = '00000000-0000-0000-0000-0000000000p1';
-- stock ahora en 8

select * from anular_venta(
  '00000000-0000-0000-0000-0000000000v2',
  (select id from usuarios where nombre = 'Angie')
);

select stock from productos where id = '00000000-0000-0000-0000-0000000000p1';
-- Esperado: 10 (repuesto)
select saldo_pendiente from clientes where id = '00000000-0000-0000-0000-0000000000c2';
-- Esperado: 0 (700 - 700)
```

Expected: stock vuelve a `10`, saldo del cliente queda en `0`.

- [ ] **Step 4: Verificar el caso límite bloqueado — saldo insuficiente para anular**

```sql
-- Reusar el mismo cliente (saldo ya en 0 tras el step anterior) y crear otra venta a crédito
insert into ventas (id, folio, tipo, cliente_id, vendedor_id, total, enganche)
values (
  '00000000-0000-0000-0000-0000000000v3',
  'REC-TESTVT03',
  'credito',
  '00000000-0000-0000-0000-0000000000c2',
  (select id from usuarios where nombre = 'Angie'),
  500,
  0
);
update clientes set saldo_pendiente = saldo_pendiente + 500 where id = '00000000-0000-0000-0000-0000000000c2';
-- saldo ahora en 500

-- El cliente abona esos 500 (simulado directo, sin pasar por registrar_abono)
update clientes set saldo_pendiente = saldo_pendiente - 500 where id = '00000000-0000-0000-0000-0000000000c2';
-- saldo vuelve a 0, pero la venta REC-TESTVT03 sigue "debiendo" 500 en teoría

select * from anular_venta(
  '00000000-0000-0000-0000-0000000000v3',
  (select id from usuarios where nombre = 'Angie')
);
-- Esperado: error "SALDO_INSUFICIENTE_PARA_ANULAR"

select anulado from ventas where id = '00000000-0000-0000-0000-0000000000v3';
-- Esperado: false (no se marcó anulada, la operación completa se abortó)
```

Expected: la llamada lanza `SALDO_INSUFICIENTE_PARA_ANULAR` y la venta queda sin marcar como anulada (confirma que el `raise exception` revirtió todo, incluido cualquier cambio parcial).

- [ ] **Step 5: Verificar permisos — un vendedor no puede anular la venta de otro**

```sql
select * from anular_venta(
  '00000000-0000-0000-0000-0000000000v1',
  (select id from usuarios where nombre = 'Alexa')
);
-- Esperado: error "PERMISO_DENEGADO" (v1 ya está anulada por Step 2, así que primero
-- confirmar que el error es PERMISO_DENEGADO y no YA_ANULADO — si sale YA_ANULADO,
-- repetir la prueba contra REC-TESTVT02 en vez de v1, que también pertenece a Angie)
```

Expected: `PERMISO_DENEGADO`. Si la venta usada ya estaba anulada por un paso previo, repetir la prueba insertando una venta nueva de contado asignada a Angie y llamando la función con el `usuario_id` de Alexa.

- [ ] **Step 6: Limpiar todos los datos de prueba**

```sql
delete from venta_items where venta_id in (
  '00000000-0000-0000-0000-0000000000v1',
  '00000000-0000-0000-0000-0000000000v2',
  '00000000-0000-0000-0000-0000000000v3'
);
delete from ventas where id in (
  '00000000-0000-0000-0000-0000000000v1',
  '00000000-0000-0000-0000-0000000000v2',
  '00000000-0000-0000-0000-0000000000v3'
);
delete from productos where id = '00000000-0000-0000-0000-0000000000p1';
delete from clientes where id = '00000000-0000-0000-0000-0000000000c2';

select count(*) from productos where nombre = 'Test Producto Anulacion';
select count(*) from clientes where nombre = 'Test Cliente Credito';
-- Esperado: 0 y 0
```

---

### Task 3: Scaffold de la pantalla Historial (HTML + CSS)

**Files:**
- Modify: `index.html:65-72` (agregar botón de acción rápida después de "Nuevo abono"), `index.html:267` (agregar el panel nuevo justo después de cerrar `#abono-panel` y antes de `<div id="toast">`)
- Modify: `styles.css` (agregar sección nueva al final del archivo)

**Interfaces:**
- Consumes: clases ya existentes `.fullscreen-overlay`, `.fs-header`, `.fs-content`, `.icon-btn`, `.chip-row`, `.chip`, `.list`, `.list-item`, `.tab-placeholder`, `.quick-action` (definidas en `styles.css`).
- Produces: elementos `#btn-historial`, `#historial-panel`, `#historial-cerrar`, `#historial-filtros`, `#historial-list`, `#historial-empty` — IDs que Task 4 y Task 5 usan desde `app.js`. Clases CSS nuevas `.quick-action-outline`, `.historial-item`, `.historial-item.anulado`, `.historial-item-right`, `.historial-monto`, `.historial-anulado-tag`, `.btn-anular`.

- [ ] **Step 1: Agregar el botón "Historial" en `tab-inicio`**

En `index.html`, después del botón `#btn-nuevo-abono` (línea 68) y antes del `<p class="placeholder">`:

```html
        <button id="btn-historial" class="quick-action quick-action-outline">
          <span class="quick-action-icon">📋</span>
          Historial
        </button>
```

- [ ] **Step 2: Agregar el panel `#historial-panel`**

En `index.html`, justo después de `</div>` que cierra `#abono-panel` (línea 267) y antes de `<div id="toast"></div>`:

```html
  <!-- ============ Panel Historial (fullscreen) ============ -->
  <div id="historial-panel" class="fullscreen-overlay">
    <div class="fs-header">
      <button id="historial-cerrar" class="icon-btn" type="button">✕</button>
      <h3>Historial</h3>
      <span style="width:32px"></span>
    </div>

    <div class="fs-content">
      <div id="historial-filtros" class="chip-row"></div>
      <div id="historial-list" class="list"></div>
      <p id="historial-empty" class="tab-placeholder" style="display:none;">
        Aún no hay ventas ni abonos registrados.
      </p>
    </div>
  </div>
```

- [ ] **Step 3: Agregar los estilos nuevos al final de `styles.css`**

```css
/* ---------- Historial ---------- */

.quick-action-outline {
  background: var(--card);
  color: var(--navy);
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(18, 35, 63, 0.05);
}

.historial-item {
  cursor: default;
  align-items: flex-start;
}

.historial-item.anulado {
  opacity: 0.55;
}

.historial-item-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.historial-monto {
  font-weight: 700;
  font-size: 15px;
  color: var(--navy);
}

.historial-item.anulado .historial-monto {
  text-decoration: line-through;
  color: var(--muted);
}

.historial-anulado-tag {
  color: var(--error);
  font-weight: 600;
}

.btn-anular {
  background: transparent;
  border: 1px solid var(--error);
  color: var(--error);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.btn-anular:active {
  filter: brightness(0.95);
}
```

- [ ] **Step 4: Verificar visualmente que el botón y el panel vacío abren/cierran**

Abrir `index.html` en el navegador (Live Server o equivalente), iniciar sesión, y en la pestaña Inicio:

Expected: aparece un tercer botón "📋 Historial" con estilo claro/outline (distinto de los dos botones de gradiente). Al tocarlo se abre un panel fullscreen con header "Historial", una fila de chips vacía (los chips los llena Task 4) y el mensaje "Aún no hay ventas ni abonos registrados." Al tocar ✕ el panel se cierra. No debe haber errores en la consola del navegador (`loadHistorial`/`openHistorialPanel` todavía no existen hasta Task 4 — el botón puede no hacer nada útil aún salvo que Task 4 ya esté implementada; si se prueba este paso de forma aislada, basta con verificar el HTML/CSS abriendo el panel manualmente vía `document.getElementById('historial-panel').classList.add('show')` en la consola).

---

### Task 4: Cargar y renderizar el Historial (JS)

**Files:**
- Modify: `app.js` (agregar sección nueva "Historial" después de la sección "Abonos", antes de "Init" — es decir, después de `initAbonos` en la línea 863 y antes de `// ---------- Init ----------` en la línea 865)
- Modify: `app.js:867-886` (`init()` — agregar `initHistorial();`)

**Interfaces:**
- Consumes: `supabase` (export de la línea 7), `toast()` (línea 13), `getSession()` (línea 36), `escapeHtml()` (línea 138), `money` (línea 135), `fechaFmt` (línea 440) — todos ya definidos en `app.js`. Constraints de FK ya existentes en Supabase: `ventas_vendedor_id_fkey`, `ventas_anulado_por_fkey`, `ventas_cliente_id_fkey`, `abonos_vendedor_id_fkey`, `abonos_anulado_por_fkey`, `abonos_cliente_id_fkey`.
- Produces: `openHistorialPanel()`, `closeHistorialPanel()`, `loadHistorial()`, `renderHistorial()`, `initHistorial()` — Task 5 llama `loadHistorial()` después de anular para refrescar la lista, y agrega el botón "Anular" dentro de `renderHistorial()`.

- [ ] **Step 1: Agregar la sección "Historial" en `app.js`**

Insertar antes de `// ---------- Init ----------`:

```js
// ---------- Historial ----------

let historialCache = [];
let historialFiltroActual = 'todos';

async function loadHistorial() {
  const [{ data: ventas, error: ventasError }, { data: abonos, error: abonosError }] = await Promise.all([
    supabase.from('ventas').select(`
      id, folio, tipo, total, enganche, creado_en, anulado, anulado_en, vendedor_id,
      cliente:clientes(nombre),
      vendedor:usuarios!ventas_vendedor_id_fkey(nombre),
      anulador:usuarios!ventas_anulado_por_fkey(nombre)
    `).order('creado_en', { ascending: false }).limit(200),
    supabase.from('abonos').select(`
      id, folio, monto, creado_en, anulado, anulado_en, vendedor_id,
      cliente:clientes(nombre),
      vendedor:usuarios!abonos_vendedor_id_fkey(nombre),
      anulador:usuarios!abonos_anulado_por_fkey(nombre)
    `).order('creado_en', { ascending: false }).limit(200),
  ]);

  if (ventasError || abonosError) {
    toast('No se pudo cargar el historial.', 'error');
    return;
  }

  const itemsVenta = (ventas || []).map((v) => ({
    tipo: 'venta',
    id: v.id,
    folio: v.folio,
    ventaTipo: v.tipo,
    monto: Number(v.total),
    creadoEn: new Date(v.creado_en),
    anulado: v.anulado,
    anuladoEn: v.anulado_en ? new Date(v.anulado_en) : null,
    anuladorNombre: v.anulador ? v.anulador.nombre : null,
    clienteNombre: v.cliente ? v.cliente.nombre : null,
    vendedorNombre: v.vendedor ? v.vendedor.nombre : '—',
    vendedorId: v.vendedor_id,
  }));

  const itemsAbono = (abonos || []).map((a) => ({
    tipo: 'abono',
    id: a.id,
    folio: a.folio,
    monto: Number(a.monto),
    creadoEn: new Date(a.creado_en),
    anulado: a.anulado,
    anuladoEn: a.anulado_en ? new Date(a.anulado_en) : null,
    anuladorNombre: a.anulador ? a.anulador.nombre : null,
    clienteNombre: a.cliente ? a.cliente.nombre : null,
    vendedorNombre: a.vendedor ? a.vendedor.nombre : '—',
    vendedorId: a.vendedor_id,
  }));

  historialCache = [...itemsVenta, ...itemsAbono].sort((a, b) => b.creadoEn - a.creadoEn);
  renderHistorial();
}

function renderHistorialFiltros() {
  const cont = document.getElementById('historial-filtros');
  cont.innerHTML = '';
  const opciones = [
    { value: 'todos', label: 'Todos' },
    { value: 'venta', label: 'Ventas' },
    { value: 'abono', label: 'Abonos' },
  ];
  opciones.forEach(({ value, label }) => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (value === historialFiltroActual ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      historialFiltroActual = value;
      renderHistorialFiltros();
      renderHistorial();
    });
    cont.appendChild(btn);
  });
}

function renderHistorial() {
  const list = document.getElementById('historial-list');
  const empty = document.getElementById('historial-empty');
  const session = getSession();

  const items = historialFiltroActual === 'todos'
    ? historialCache
    : historialCache.filter((item) => item.tipo === historialFiltroActual);

  list.innerHTML = '';
  empty.style.display = items.length === 0 ? 'block' : 'none';

  items.forEach((item) => {
    const puedeAnular = !item.anulado && session &&
      (session.rol === 'admin' || session.id === item.vendedorId);

    const card = document.createElement('div');
    card.className = 'list-item historial-item' + (item.anulado ? ' anulado' : '');

    const tituloTipo = item.tipo === 'venta'
      ? `🛒 ${escapeHtml(item.folio)} · ${item.ventaTipo === 'credito' ? 'Crédito' : 'Contado'}`
      : `💵 ${escapeHtml(item.folio)}`;

    const anuladoTag = item.anulado
      ? `<div class="li-sub historial-anulado-tag">Anulado por ${escapeHtml(item.anuladorNombre || '—')} · ${fechaFmt.format(item.anuladoEn)}</div>`
      : '';

    card.innerHTML = `
      <div class="li-main">
        <div class="li-title">${tituloTipo}</div>
        <div class="li-sub">${item.clienteNombre ? escapeHtml(item.clienteNombre) : 'Sin cliente'} · ${escapeHtml(item.vendedorNombre)} · ${fechaFmt.format(item.creadoEn)}</div>
        ${anuladoTag}
      </div>
      <div class="historial-item-right">
        <div class="historial-monto">${money.format(item.monto)}</div>
        ${puedeAnular ? '<button type="button" class="btn-anular">Anular</button>' : ''}
      </div>
    `;

    if (puedeAnular) {
      card.querySelector('.btn-anular').addEventListener('click', () => confirmarAnular(item));
    }

    list.appendChild(card);
  });
}

async function openHistorialPanel() {
  historialFiltroActual = 'todos';
  renderHistorialFiltros();
  document.getElementById('historial-panel').classList.add('show');
  await loadHistorial();
}

function closeHistorialPanel() {
  document.getElementById('historial-panel').classList.remove('show');
}

function initHistorial() {
  document.getElementById('btn-historial').addEventListener('click', openHistorialPanel);
  document.getElementById('historial-cerrar').addEventListener('click', closeHistorialPanel);
}
```

Nota: `confirmarAnular(item)` todavía no existe — se define en Task 5. Dejar la referencia tal cual; el archivo no se ejecuta a prueba real hasta que Task 5 la agregue (JS con `function` declarations se resuelve en tiempo de definición del módulo, así que no rompe la carga del script, solo fallaría si alguien da clic en "Anular" antes de que Task 5 esté aplicado).

- [ ] **Step 2: Registrar `initHistorial()` en `init()`**

En `app.js`, dentro de `function init()` (línea 867), agregar la llamada junto a las demás `init*`:

```js
  initNav();
  initClientes();
  initInventario();
  initVentas();
  initAbonos();
  initHistorial();
```

- [ ] **Step 3: Verificar en el navegador con datos reales**

Con al menos una venta de contado, una venta a crédito y un abono ya existentes (usar los flujos de los tickets 05/06/07 para crear alguno si no hay datos), abrir Historial desde Inicio.

Expected: la lista muestra los tres tipos de movimiento, ordenados del más reciente al más antiguo, cada uno con folio, cliente (o "Sin cliente"), vendedor, fecha y monto correctos. Los chips Todos/Ventas/Abonos filtran correctamente al tocarlos. Ningún registro debe mostrarse tachado todavía (nada se ha anulado). El botón "Anular" aparece en cada card visible para el usuario logueado (según su rol/autoría) pero al tocarlo no debe pasar nada útil todavía (se implementa en Task 5) — confirmar solo que no lanza error de JS en consola por falta de la función (si lanza `confirmarAnular is not defined`, es esperado hasta completar Task 5; si el botón no aparece en absoluto por error de sintaxis, hay que revisar el Step 1).

---

### Task 5: Flujo de anular (confirmación + RPC + manejo de errores)

**Files:**
- Modify: `app.js` (agregar `confirmarAnular` dentro de la sección "Historial" creada en Task 4, justo antes de `initHistorial()`)

**Interfaces:**
- Consumes: `assertOnline()` (línea 26), `getSession()` (línea 36), `toast()` (línea 13), `money` (línea 135), `supabase.rpc('anular_venta' | 'anular_abono', ...)` (Tasks 1 y 2), `loadHistorial()` / `loadProductos()` (línea 259) / `loadClientes()` (línea 144) — todas ya definidas.
- Produces: `confirmarAnular(item)` — referenciada desde `renderHistorial()` (Task 4).

- [ ] **Step 1: Agregar `confirmarAnular` en `app.js`**

Insertar dentro de la sección "Historial", justo antes de `function initHistorial() {`:

```js
async function confirmarAnular(item) {
  if (!assertOnline()) return;

  const tipoLabel = item.tipo === 'venta' ? 'venta' : 'abono';
  const ok = window.confirm(
    `¿Seguro que quieres anular esta ${tipoLabel} de ${money.format(item.monto)} (folio ${item.folio})? No se puede deshacer.`
  );
  if (!ok) return;

  const session = getSession();
  const rpcName = item.tipo === 'venta' ? 'anular_venta' : 'anular_abono';
  const params = item.tipo === 'venta'
    ? { p_venta_id: item.id, p_usuario_id: session.id }
    : { p_abono_id: item.id, p_usuario_id: session.id };

  const { error } = await supabase.rpc(rpcName, params);

  if (error) {
    const msg = error.message || '';
    if (msg.includes('PERMISO_DENEGADO')) {
      toast('No tienes permiso para anular este registro.', 'error');
    } else if (msg.includes('YA_ANULADO')) {
      toast('Este registro ya estaba anulado.', 'error');
    } else if (msg.includes('SALDO_INSUFICIENTE_PARA_ANULAR')) {
      toast('No se puede anular: el cliente ya abonó contra este saldo. Contacta al admin.', 'error');
    } else {
      toast('No se pudo anular. Intenta de nuevo.', 'error');
    }
    return;
  }

  toast('Registro anulado.');
  loadHistorial();
  loadProductos();
  loadClientes();
}
```

- [ ] **Step 2: Verificar en el navegador — anular una venta de contado propia**

Con la sesión de un vendedor (ej. Angie), crear una venta de contado nueva desde "Nueva venta", luego abrir Historial y tocar "Anular" sobre esa venta, confirmar el diálogo.

Expected: toast "Registro anulado.", la card pasa a verse atenuada con el monto tachado y la leyenda "Anulado por Angie · {fecha}", el botón "Anular" desaparece de esa card. Ir a Inventario y confirmar que el stock del producto vendido volvió a su valor anterior.

- [ ] **Step 3: Verificar permisos — un vendedor no ve "Anular" en un registro ajeno**

Cerrar sesión, entrar como otro vendedor (ej. Alexa) que no haya creado ningún movimiento, abrir Historial.

Expected: en los registros creados por Angie o Papá, no aparece el botón "Anular" (solo aparece en los propios, si los hay). Si se crea un registro con Alexa, confirmar que ahí sí aparece el botón.

- [ ] **Step 4: Verificar rol admin — Papá puede anular cualquier registro**

Entrar como "Papá", abrir Historial.

Expected: el botón "Anular" aparece en todos los registros no anulados, sin importar quién los creó. Anular uno creado por otro vendedor funciona igual que el Step 2.

- [ ] **Step 5: Verificar el caso de venta a crédito — saldo baja correctamente**

Crear una venta a crédito con enganche (ej. total $1,000, enganche $300 → saldo cliente sube $700), anularla desde Historial.

Expected: toast de éxito, stock repuesto, y en la pestaña Clientes el saldo de ese cliente baja de vuelta en $700 (vuelve a su valor previo a la venta).

- [ ] **Step 6: Verificar el bloqueo por saldo insuficiente**

Crear una venta a crédito sin enganche por $500 a un cliente sin saldo previo (saldo sube a $500), luego registrar un abono de $500 sobre ese mismo cliente (saldo baja a $0), y finalmente intentar anular la venta original desde Historial.

Expected: toast de error "No se puede anular: el cliente ya abonó contra este saldo. Contacta al admin." La venta sigue apareciendo como no anulada (sin tachar, con botón "Anular" visible) y el saldo del cliente no cambia.

- [ ] **Step 7: Verificar anular un abono**

Con un cliente que tenga saldo pendiente > 0, registrar un abono, luego anularlo desde Historial.

Expected: toast de éxito, el saldo del cliente vuelve a subir el monto abonado, la card queda tachada con "Anulado por {nombre}".

- [ ] **Step 8: Verificar sin conexión**

Con las herramientas de red del navegador, simular `navigator.onLine = false` (o desconectar la red) y tocar "Anular" sobre cualquier registro no anulado.

Expected: toast de error "Sin conexión a internet. Esta acción requiere estar en línea." — el diálogo de confirmación ni siquiera debe abrirse (el chequeo ocurre antes del `confirm()`), y nada cambia en la base de datos.

---

### Task 6: Regresión completa y cierre del ticket

**Files:**
- Modify: `TICKETS.md:198-214` (marcar el ticket 08 con los checkboxes completados y agregar el bloque "Estado", mismo formato que los tickets 01-07)

**Interfaces:**
- Consumes: ninguna nueva — este task es de verificación y documentación.
- Produces: `TICKETS.md` actualizado, listo para pasar al ticket 09.

- [ ] **Step 1: Pasada de regresión rápida sobre los módulos existentes**

Repetir brevemente los flujos ya cubiertos por los tickets 05-07 (venta de contado, venta a crédito, abono) para confirmar que Historial no rompió nada: crear cada uno y verificar que sigue apareciendo correctamente en Historial y que los recibos existentes siguen funcionando igual que antes.

Expected: sin regresiones — todos los flujos previos siguen funcionando exactamente igual, y cada movimiento nuevo aparece de inmediato en Historial al reabrir el panel.

- [ ] **Step 2: Doble tap — anular dos veces rápido**

Sobre un registro no anulado, tocar "Anular", confirmar, y de inmediato (antes de que la lista se refresque) intentar tocar "Anular" otra vez si el botón alcanza a seguir visible.

Expected: el segundo intento (si llega a dispararse) recibe "Este registro ya estaba anulado." vía la función SQL, nunca revierte el efecto dos veces (confirmar en Clientes/Inventario que el saldo/stock solo se ajustó una vez).

- [ ] **Step 3: Actualizar `TICKETS.md`**

Reemplazar el bloque del ticket 08 (líneas 198-214) por:

```markdown
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
```

- [ ] **Step 4: Confirmar el resultado leyendo el archivo**

Releer `TICKETS.md` completo y confirmar que el ticket 08 quedó con el mismo formato visual (✅ en el título, bloque **Estado**, checkboxes marcados) que los tickets 01-07 inmediatamente anteriores.
