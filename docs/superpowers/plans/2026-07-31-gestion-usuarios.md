# Ticket 12 — Gestión de usuarios — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar la lista fija de 4 usuarios sembrada a mano en Supabase por gestión completa desde la propia app — alta, edición, desactivación/reactivación (nunca borrado) y contraseñas (autoservicio + reseteo por admin) — sentando la base para el ticket 13 (multi-almacén), que depende de este.

**Architecture:** Una columna nueva `usuarios.activo` + cuatro funciones SQL `SECURITY DEFINER` nuevas (`crear_usuario`, `cambiar_contrasena`, `admin_resetear_password`, `cambiar_estatus_usuario`) más un ajuste de una línea en `login_usuario()` existente. En el frontend, una pantalla nueva "Mi cuenta" (panel fullscreen, mismo patrón que Venta/Abono/Historial) accesible desde un ícono nuevo en el topbar, con dos secciones: "Mi cuenta" (todos los roles, cambio de contraseña) y "Usuarios" (solo admin, alta/edición/desactivación). El login deja de tener un `<select>` hardcodeado y se puebla dinámicamente desde `usuarios where activo = true`.

**Tech Stack:** HTML/CSS/JS vanilla (sin build step, `<script type="module">`), Supabase JS v2 (`@supabase/supabase-js`), Postgres/plpgsql en Supabase (proyecto `ventas-familia`, ref `wiewxgkiefsjeonirsid`).

## Global Constraints

- Nunca se borra un usuario físicamente — se marca `activo = false`, reversible (SPEC / diseño ticket 12 sección 1.3).
- Nunca se permite desactivar al último admin activo — validado server-side en `cambiar_estatus_usuario`, no solo en el frontend (diseño ticket 12 sección 1.8).
- Cambiar `activo` **nunca** es un `update` directo desde el cliente — siempre pasa por `cambiar_estatus_usuario()` (diseño ticket 12 sección 2). Editar `nombre`/`rol` sí es un `update` directo, mismo patrón que `clientes`/`productos`.
- Solo el rol `admin` ve y usa la sección "Usuarios" — un `vendedor` solo ve su propio cambio de contraseña (diseño ticket 12 sección 1.1).
- Ninguna operación de escritura debe fallar en silencio ni encolarse sin conexión — usar `assertOnline()` antes de cualquier RPC de escritura (patrón ya establecido en `app.js`).
- No se agregan dependencias nuevas ni build step — todo el código sigue siendo HTML/CSS/JS plano cargado directo por el navegador.
- Seguir la paleta y componentes visuales ya definidos en `styles.css` (`.fullscreen-overlay`, `.sheet-overlay`, `.list-item`, `.li-badge`, `.toggle-group`, `.field`, `.btn-primary`/`.btn-outline`) — no introducir un sistema visual paralelo.
- Las funciones SQL siguen el estilo ya establecido por `registrar_venta`/`anular_venta`: `plpgsql`, `SECURITY DEFINER`, `SET search_path TO 'public'`, errores de negocio comunicados con `RAISE EXCEPTION '<CODIGO_EN_MAYUSCULAS>'` que el cliente detecta con `error.message.includes(...)`.
- No hay framework de pruebas automatizadas en este proyecto — la verificación de cada tarea es manual: SQL directo contra Supabase (para las funciones) y navegador (para la UI), documentando el resultado igual que en los tickets 01-11 de `TICKETS.md`.
- Cada vez que se modifica `app.js` o `styles.css`, subir el número en `sw.js` → `const CACHE = 'vf-vX'` (actualmente `vf-v4`).
- **`pgcrypto` vive en el schema `extensions`, no en `public`:** cualquier función SQL que use `crypt()` o `gen_salt()` (`crear_usuario`, `cambiar_contrasena`, `admin_resetear_password`) necesita `set search_path to 'public', 'extensions'` — `'public'` solo no basta y falla en tiempo de ejecución con `function gen_salt(...) does not exist` (confirmado en Tasks 1 y 2 de este plan). `cambiar_estatus_usuario` (Task 5) no usa `crypt`/`gen_salt`, así que le basta `'public'`.
- **Nota operativa de este plan:** la tool `execute_sql` del MCP de Supabase puede devolver resultados truncados/comprimidos e irrecuperables en algunas sesiones (falla del entorno, no del proyecto). Si un `select` de verificación regresa contenido ilegible o vacío, usar en su lugar `apply_migration` con un bloque `do $$ ... $$;` que haga el `select`/assert internamente y termine con `raise exception '%', <valor o mensaje>` — `apply_migration` siempre regresa texto limpio y completo, tanto en éxito (`{"success":true}`) como en el mensaje de error de un `raise exception` forzado. Este mecanismo ya se usó y confirmó en esta sesión para leer la definición real de `login_usuario()` (ver Task 1). Cualquier migración de prueba con nombre `test_probe_*` o `probe_*` que aparezca en `list_migrations` es un descarte de diagnóstico de esta sesión, sin efecto en el esquema (no requiere limpieza).

---

### Task 1: Esquema — columna `usuarios.activo` + refuerzo de `login_usuario()`

**Files:**
- Supabase (proyecto `wiewxgkiefsjeonirsid`), vía `apply_migration` con nombre `usuarios_activo`. No hay archivo `.sql` local — el proyecto no versiona migraciones en el repo (mismo patrón que tickets anteriores).

**Interfaces:**
- Consumes: tabla `usuarios` (`id, nombre, rol, password_hash, creado_en`) — existente.
- Produces: columna `usuarios.activo boolean not null default true`; `login_usuario(p_nombre text, p_password text)` rechaza usuarios con `activo = false`. Consumido por Task 6 (login dinámico) y por todas las demás tasks de este plan.

- [ ] **Step 1: Definición actual de `login_usuario()` (ya confirmada — no repetir la lectura)**

La definición real desplegada hoy en Supabase (confirmada en esta sesión vía un bloque `do $$ ... raise exception '%', pg_get_functiondef(oid) ... $$;` aplicado con `apply_migration`, que devuelve el texto completo sin truncar) es:

```sql
CREATE OR REPLACE FUNCTION public.login_usuario(p_nombre text, p_password text)
 RETURNS TABLE(id uuid, nombre text, rol text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  return query
  select u.id, u.nombre, u.rol
  from usuarios u
  where u.nombre = p_nombre
    and u.password_hash = crypt(p_password, u.password_hash);
end;
$function$
```

Nota importante: el `search_path` real incluye `'extensions'` además de `'public'` (ahí vive `crypt()`, de `pgcrypto`) — el Step 2 de abajo ya lo preserva. No hace falta volver a leerla.

- [ ] **Step 2: Aplicar la migración — columna `activo` + `login_usuario()` reforzada**

Ejecutar con `apply_migration` (`project_id: wiewxgkiefsjeonirsid`, `name: usuarios_activo`):

```sql
alter table public.usuarios add column activo boolean not null default true;

create or replace function public.login_usuario(p_nombre text, p_password text)
returns table(id uuid, nombre text, rol text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  return query
  select u.id, u.nombre, u.rol
  from usuarios u
  where u.nombre = p_nombre
    and u.activo = true
    and u.password_hash = crypt(p_password, u.password_hash);
end;
$function$;
```

- [ ] **Step 3: Verificar con datos reales**

Intentar primero con `execute_sql`. Si en tu sesión regresa resultados legibles, usar directamente:

```sql
select nombre, activo from usuarios order by nombre;

update usuarios set activo = false where nombre = 'Alexis';
select * from login_usuario('Alexis', '2026'); -- Esperado: 0 filas

update usuarios set activo = true where nombre = 'Alexis';
select * from login_usuario('Alexis', '2026'); -- Esperado: 1 fila, rol='vendedor'
```

Si `execute_sql` regresa contenido ilegible/truncado (ver nota operativa en Global Constraints), usar en su lugar `apply_migration` con este bloque de asserts (nombre de migración: `usuarios_activo_verify` — es un descarte de diagnóstico, no altera el esquema más allá de las actualizaciones de datos que él mismo revierte al final):

```sql
do $$
declare
  v_total_activos int;
  v_filas_tras_desactivar int;
  v_filas_tras_reactivar int;
begin
  select count(*) into v_total_activos from usuarios where activo = true;
  if v_total_activos < 4 then
    raise exception 'FALLO: esperaba al menos 4 usuarios activos por default, hay %', v_total_activos;
  end if;

  update usuarios set activo = false where nombre = 'Alexis';
  select count(*) into v_filas_tras_desactivar from login_usuario('Alexis', '2026');
  if v_filas_tras_desactivar <> 0 then
    raise exception 'FALLO: login_usuario regreso % filas para Alexis desactivada, esperaba 0', v_filas_tras_desactivar;
  end if;

  update usuarios set activo = true where nombre = 'Alexis';
  select count(*) into v_filas_tras_reactivar from login_usuario('Alexis', '2026');
  if v_filas_tras_reactivar <> 1 then
    raise exception 'FALLO: login_usuario regreso % filas para Alexis reactivada, esperaba 1', v_filas_tras_reactivar;
  end if;

  raise exception 'OK: los 3 asserts de Task 1 pasaron correctamente';
end $$;
```

Expected: el bloque termina SIEMPRE con un error (por diseño, `do` no puede regresar datos sin un `raise exception`) — lo que importa es el TEXTO del mensaje: si dice `OK: los 3 asserts...`, la verificación pasó; si dice `FALLO: ...`, corregir la Step 2 y repetir. Confirmar al final que `Alexis` quedó `activo = true` (el propio bloque ya la reactiva antes de terminar).

---

### Task 2: Función SQL `crear_usuario`

**Files:**
- Supabase, vía `apply_migration` con nombre `crear_usuario_fn`.

**Interfaces:**
- Consumes: tabla `usuarios` (constraint `unique` en `nombre`, ya existente desde ticket 01; `check` de `rol` ya existente).
- Produces: `crear_usuario(p_nombre text, p_password text, p_rol text) returns table(id uuid, nombre text, rol text)`, consumida por Task 9 (`app.js`) vía `supabase.rpc('crear_usuario', {...})`. Errores: `ROL_INVALIDO`, `DATOS_INVALIDOS`, `23505` (nombre duplicado, código nativo de Postgres).

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.crear_usuario(p_nombre text, p_password text, p_rol text)
returns table(id uuid, nombre text, rol text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
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
$function$;
```

- [ ] **Step 2: Verificar con datos reales usando `execute_sql`**

```sql
-- Alta exitosa
select * from crear_usuario('Test Usuario Nuevo', 'clave123', 'vendedor');
-- Esperado: 1 fila con nombre='Test Usuario Nuevo', rol='vendedor'

-- Puede iniciar sesión de inmediato
select * from login_usuario('Test Usuario Nuevo', 'clave123');
-- Esperado: 1 fila

-- Nombre duplicado
select * from crear_usuario('Test Usuario Nuevo', 'otraclave', 'admin');
-- Esperado: error código 23505 (unique_violation)

-- Rol inválido
select * from crear_usuario('Test Usuario Rol Malo', 'clave123', 'superadmin');
-- Esperado: error "ROL_INVALIDO"

-- Datos vacíos
select * from crear_usuario('', 'clave123', 'vendedor');
-- Esperado: error "DATOS_INVALIDOS"
```

Expected: los cinco resultados coinciden. Confirmar que los intentos fallidos (rol inválido, datos vacíos, nombre duplicado) no dejaron ninguna fila parcial.

- [ ] **Step 3: Limpiar el dato de prueba**

```sql
delete from usuarios where nombre = 'Test Usuario Nuevo';
select count(*) from usuarios where nombre = 'Test Usuario Nuevo';
-- Esperado: 0
```

---

### Task 3: Función SQL `cambiar_contrasena`

**Files:**
- Supabase, vía `apply_migration` con nombre `cambiar_contrasena_fn`.

**Interfaces:**
- Consumes: tabla `usuarios` (`id, password_hash`).
- Produces: `cambiar_contrasena(p_usuario_id uuid, p_password_actual text, p_password_nueva text) returns void`, consumida por Task 8 (`app.js`, sección "Mi cuenta"). Errores: `PASSWORD_ACTUAL_INCORRECTA`, `PASSWORD_INVALIDA`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.cambiar_contrasena(
  p_usuario_id uuid, p_password_actual text, p_password_nueva text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_hash text;
begin
  select password_hash into v_hash from usuarios where id = p_usuario_id;

  if v_hash is null or crypt(p_password_actual, v_hash) <> v_hash then
    raise exception 'PASSWORD_ACTUAL_INCORRECTA';
  end if;

  if p_password_nueva is null or p_password_nueva = '' then
    raise exception 'PASSWORD_INVALIDA';
  end if;

  update usuarios set password_hash = crypt(p_password_nueva, gen_salt('bf'))
  where id = p_usuario_id;
end;
$function$;
```

- [ ] **Step 2: Verificar con datos reales usando `execute_sql`**

```sql
-- Setup: usuario de prueba con contraseña conocida
select * from crear_usuario('Test Usuario Password', 'clavevieja', 'vendedor');

-- Contraseña actual incorrecta → bloqueado
select cambiar_contrasena(
  (select id from usuarios where nombre = 'Test Usuario Password'),
  'clave-equivocada', 'clavenueva'
);
-- Esperado: error "PASSWORD_ACTUAL_INCORRECTA"

-- Contraseña nueva vacía → bloqueado
select cambiar_contrasena(
  (select id from usuarios where nombre = 'Test Usuario Password'),
  'clavevieja', ''
);
-- Esperado: error "PASSWORD_INVALIDA"

-- Cambio correcto
select cambiar_contrasena(
  (select id from usuarios where nombre = 'Test Usuario Password'),
  'clavevieja', 'clavenueva'
);

-- Confirmar que ahora entra con la nueva y ya no con la vieja
select * from login_usuario('Test Usuario Password', 'clavenueva');
-- Esperado: 1 fila
select * from login_usuario('Test Usuario Password', 'clavevieja');
-- Esperado: 0 filas
```

Expected: los cuatro resultados coinciden exactamente.

- [ ] **Step 3: Limpiar el dato de prueba**

```sql
delete from usuarios where nombre = 'Test Usuario Password';
```

---

### Task 4: Función SQL `admin_resetear_password`

**Files:**
- Supabase, vía `apply_migration` con nombre `admin_resetear_password_fn`.

**Interfaces:**
- Consumes: tabla `usuarios` (`id, rol, activo, password_hash`).
- Produces: `admin_resetear_password(p_admin_id uuid, p_usuario_id uuid, p_password_nueva text) returns void`, consumida por Task 10 (`app.js`, sección "Usuarios"). Errores: `PERMISO_DENEGADO`, `PASSWORD_INVALIDA`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.admin_resetear_password(
  p_admin_id uuid, p_usuario_id uuid, p_password_nueva text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_rol text;
  v_activo boolean;
begin
  select rol, activo into v_rol, v_activo from usuarios where id = p_admin_id;

  if v_rol is distinct from 'admin' or v_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  if p_password_nueva is null or p_password_nueva = '' then
    raise exception 'PASSWORD_INVALIDA';
  end if;

  update usuarios set password_hash = crypt(p_password_nueva, gen_salt('bf'))
  where id = p_usuario_id;
end;
$function$;
```

- [ ] **Step 2: Verificar con datos reales usando `execute_sql`**

```sql
-- Setup
select * from crear_usuario('Test Usuario Reset', 'clavevieja', 'vendedor');

-- Un vendedor (no admin) no puede resetear
select admin_resetear_password(
  (select id from usuarios where nombre = 'Angie'),
  (select id from usuarios where nombre = 'Test Usuario Reset'),
  'nueva123'
);
-- Esperado: error "PERMISO_DENEGADO" (Angie es vendedor, ver TICKETS.md tabla de usuarios)

-- Admin resetea sin conocer la anterior
select admin_resetear_password(
  (select id from usuarios where nombre = 'Papá'),
  (select id from usuarios where nombre = 'Test Usuario Reset'),
  'nueva123'
);

select * from login_usuario('Test Usuario Reset', 'nueva123');
-- Esperado: 1 fila
select * from login_usuario('Test Usuario Reset', 'clavevieja');
-- Esperado: 0 filas
```

Expected: los tres resultados coinciden. Si "Angie" no está sembrada como `rol = 'vendedor'` o "Papá" no está como `rol = 'admin'`, confirmar los roles reales con `select nombre, rol from usuarios` y ajustar los nombres usados en la prueba.

- [ ] **Step 3: Limpiar el dato de prueba**

```sql
delete from usuarios where nombre = 'Test Usuario Reset';
```

---

### Task 5: Función SQL `cambiar_estatus_usuario` (con salvaguarda del último admin)

**Files:**
- Supabase, vía `apply_migration` con nombre `cambiar_estatus_usuario_fn`.

**Interfaces:**
- Consumes: tabla `usuarios` (`id, rol, activo`).
- Produces: `cambiar_estatus_usuario(p_admin_id uuid, p_usuario_id uuid, p_activo boolean) returns void`, consumida por Task 10. Errores: `PERMISO_DENEGADO`, `ULTIMO_ADMIN`.

- [ ] **Step 1: Aplicar la migración con la función**

```sql
create or replace function public.cambiar_estatus_usuario(
  p_admin_id uuid, p_usuario_id uuid, p_activo boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_rol text;
  v_admin_activo boolean;
  v_objetivo_rol text;
  v_otros_admins_activos int;
begin
  select rol, activo into v_admin_rol, v_admin_activo from usuarios where id = p_admin_id;

  if v_admin_rol is distinct from 'admin' or v_admin_activo is not true then
    raise exception 'PERMISO_DENEGADO';
  end if;

  if p_activo = false then
    select rol into v_objetivo_rol from usuarios where id = p_usuario_id;

    if v_objetivo_rol = 'admin' then
      select count(*) into v_otros_admins_activos
      from usuarios
      where rol = 'admin' and activo = true and id <> p_usuario_id;

      if v_otros_admins_activos = 0 then
        raise exception 'ULTIMO_ADMIN';
      end if;
    end if;
  end if;

  update usuarios set activo = p_activo where id = p_usuario_id;
end;
$function$;
```

- [ ] **Step 2: Verificar el caso normal — desactivar y reactivar un vendedor**

```sql
select * from crear_usuario('Test Usuario Estatus', 'clave123', 'vendedor');

select cambiar_estatus_usuario(
  (select id from usuarios where nombre = 'Papá'),
  (select id from usuarios where nombre = 'Test Usuario Estatus'),
  false
);
select activo from usuarios where nombre = 'Test Usuario Estatus';
-- Esperado: false

select cambiar_estatus_usuario(
  (select id from usuarios where nombre = 'Papá'),
  (select id from usuarios where nombre = 'Test Usuario Estatus'),
  true
);
select activo from usuarios where nombre = 'Test Usuario Estatus';
-- Esperado: true
```

Expected: ambos cambios se aplican correctamente.

- [ ] **Step 3: Verificar permisos — un vendedor no puede desactivar a nadie**

```sql
select cambiar_estatus_usuario(
  (select id from usuarios where nombre = 'Angie'),
  (select id from usuarios where nombre = 'Test Usuario Estatus'),
  false
);
-- Esperado: error "PERMISO_DENEGADO"
```

- [ ] **Step 4: Verificar la salvaguarda del último admin**

```sql
-- Confirmar cuántos admins activos hay hoy antes de la prueba
select nombre from usuarios where rol = 'admin' and activo = true;

-- Si "Papá" es el único admin activo, intentar desactivarlo debe bloquear:
select cambiar_estatus_usuario(
  (select id from usuarios where nombre = 'Papá'),
  (select id from usuarios where nombre = 'Papá'),
  false
);
-- Esperado: error "ULTIMO_ADMIN"

-- Crear un segundo admin de prueba y confirmar que ahora sí se permite
select * from crear_usuario('Test Admin Segundo', 'clave123', 'admin');

select cambiar_estatus_usuario(
  (select id from usuarios where nombre = 'Papá'),
  (select id from usuarios where nombre = 'Papá'),
  false
);
-- Esperado: éxito (ya no es el único admin activo)

-- Revertir de inmediato para no dejar la app sin Papá activo
select cambiar_estatus_usuario(
  (select id from usuarios where nombre = 'Test Admin Segundo'),
  (select id from usuarios where nombre = 'Papá'),
  true
);
select activo from usuarios where nombre = 'Papá';
-- Esperado: true
```

Expected: el primer intento de desactivar al único admin falla con `ULTIMO_ADMIN`; tras crear un segundo admin, la desactivación sí se permite; se revierte de inmediato dejando a "Papá" activo otra vez.

- [ ] **Step 5: Limpiar todos los datos de prueba**

```sql
delete from usuarios where nombre in ('Test Usuario Estatus', 'Test Admin Segundo');
select nombre, activo, rol from usuarios order by nombre;
-- Esperado: exactamente los usuarios reales del negocio (Papá, Angie, Alexa, Alexis, y
-- cualquier otro que ya existiera antes de este plan), todos con el estado que tenían
-- antes de empezar esta task
```

---

### Task 6: Login dinámico — el `<select>` deja de ser una lista fija

**Files:**
- Modify: `index.html:27-33` (quitar las 4 `<option>` hardcodeadas, dejar el `<select>` vacío salvo el placeholder)
- Modify: `app.js` (agregar `populateLoginUsuarios()` en la sección "Login", llamarla desde `init()` y desde `handleLogout()`)

**Interfaces:**
- Consumes: `supabase` (export), tabla `usuarios` con la columna `activo` de Task 1.
- Produces: `populateLoginUsuarios()`, exportado desde la sección "Login" de `app.js`, llamado desde `init()` (línea ~1437, antes de `showView('view-login')`) y desde `handleLogout()` (línea 107-111).

- [ ] **Step 1: Vaciar las opciones hardcodeadas en `index.html`**

Reemplazar (líneas 27-33):

```html
          <select id="login-nombre" required>
            <option value="" disabled selected>Selecciona tu nombre</option>
            <option value="Papá">Papá</option>
            <option value="Angie">Angie</option>
            <option value="Alexa">Alexa</option>
            <option value="Alexis">Alexis</option>
          </select>
```

por:

```html
          <select id="login-nombre" required>
            <option value="" disabled selected>Selecciona tu nombre</option>
          </select>
```

- [ ] **Step 2: Agregar `populateLoginUsuarios()` en `app.js`**

Insertar dentro de la sección `// ---------- Login ----------`, antes de `async function handleLogin(event) {`:

```js
async function populateLoginUsuarios() {
  const select = document.getElementById('login-nombre');
  const valorPrevio = select.value;

  const { data, error } = await supabase
    .from('usuarios')
    .select('nombre')
    .eq('activo', true)
    .order('nombre');

  select.innerHTML = '<option value="" disabled selected>Selecciona tu nombre</option>';

  if (error || !data) return;

  data.forEach(({ nombre }) => {
    const opt = document.createElement('option');
    opt.value = nombre;
    opt.textContent = nombre;
    select.appendChild(opt);
  });

  if (data.some((u) => u.nombre === valorPrevio)) {
    select.value = valorPrevio;
  }
}
```

- [ ] **Step 3: Llamarla desde `init()` y desde `handleLogout()`**

En `init()` (línea ~1437), justo antes de `const session = getSession();`:

```js
  populateLoginUsuarios();
```

En `handleLogout()` (línea 107-111):

```js
function handleLogout() {
  clearSession();
  historialCache = [];
  populateLoginUsuarios();
  showView('view-login');
}
```

- [ ] **Step 4: Verificar en el navegador**

Abrir la app sin sesión iniciada (o cerrar sesión). Expected: el `<select>` de Usuario se llena con los 4 nombres reales (Papá, Angie, Alexa, Alexis) ordenados alfabéticamente, sin nada hardcodeado en el HTML. Iniciar sesión con cualquiera de ellos debe seguir funcionando exactamente igual que antes.

---

### Task 7: Scaffold del panel "Mi cuenta" (HTML + CSS) — ícono en topbar y sección "Mi cuenta"

**Files:**
- Modify: `index.html:47-56` (agregar botón ícono "Mi cuenta" en el topbar, entre `.brand` y `#btn-logout`)
- Modify: `index.html` (agregar el panel `#cuenta-panel` nuevo, después de `#historial-panel` (línea 357) y antes de `<div id="toast">` (línea 359), con la sección "Mi cuenta" — la sección "Usuarios" se agrega en Task 9)
- Modify: `styles.css` (agregar sección nueva al final del archivo)

**Interfaces:**
- Consumes: clases ya existentes `.fullscreen-overlay`, `.fs-header`, `.fs-content`, `.fs-subtitle`, `.icon-btn`, `.field`, `.error-msg`, `.btn-primary`, `.li-badge.al-dia`/`.li-badge.pendiente`.
- Produces: `#btn-mi-cuenta`, `#cuenta-panel`, `#cuenta-cerrar`, `#cuenta-mi-nombre`, `#cuenta-mi-rol`, `#cuenta-password-actual`, `#cuenta-password-nueva`, `#cuenta-password-confirmar`, `#cuenta-password-error`, `#cuenta-password-guardar` — IDs que Task 8 usa desde `app.js`. Clase CSS nueva `.topbar-actions`, `.cuenta-mi-info`.

- [ ] **Step 1: Agregar el ícono "Mi cuenta" en el topbar**

En `index.html`, reemplazar el topbar actual (líneas 47-56):

```html
    <div class="topbar">
      <div class="brand">
        <img src="icon.svg" alt="" />
        <div class="who">
          <h2 id="main-nombre">—</h2>
          <span id="main-rol">—</span>
        </div>
      </div>
      <div class="topbar-actions">
        <button id="btn-mi-cuenta" class="icon-btn" type="button" aria-label="Mi cuenta">👤</button>
        <button id="btn-logout" class="btn btn-ghost">Salir</button>
      </div>
    </div>
```

- [ ] **Step 2: Agregar el panel `#cuenta-panel` con la sección "Mi cuenta"**

En `index.html`, justo después de `</div>` que cierra `#historial-panel` y antes de `<div id="toast"></div>`:

```html
  <!-- ============ Panel Mi cuenta (fullscreen) ============ -->
  <div id="cuenta-panel" class="fullscreen-overlay">
    <div class="fs-header">
      <button id="cuenta-cerrar" class="icon-btn" type="button">✕</button>
      <h3>Mi cuenta</h3>
      <span style="width:32px"></span>
    </div>

    <div class="fs-content">
      <h3 class="fs-subtitle">Mi cuenta</h3>
      <div class="cuenta-mi-info">
        <div class="li-title" id="cuenta-mi-nombre">—</div>
        <div class="li-sub" id="cuenta-mi-rol">—</div>
      </div>

      <h3 class="fs-subtitle">Cambiar mi contraseña</h3>
      <div class="field">
        <label for="cuenta-password-actual">Contraseña actual</label>
        <input id="cuenta-password-actual" type="password" autocomplete="off" />
      </div>
      <div class="field">
        <label for="cuenta-password-nueva">Nueva contraseña</label>
        <input id="cuenta-password-nueva" type="password" autocomplete="off" />
      </div>
      <div class="field">
        <label for="cuenta-password-confirmar">Confirmar nueva contraseña</label>
        <input id="cuenta-password-confirmar" type="password" autocomplete="off" />
      </div>
      <p id="cuenta-password-error" class="error-msg"></p>
      <button id="cuenta-password-guardar" type="button" class="btn btn-primary">Cambiar contraseña</button>

      <div id="cuenta-usuarios-seccion" style="display:none;">
        <!-- Task 9 agrega aquí la sección "Usuarios" (solo admin) -->
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Agregar los estilos nuevos al final de `styles.css`**

```css
/* ---------- Mi cuenta ---------- */

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cuenta-mi-info {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 8px;
}

.cuenta-mi-info .li-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--text);
}

.cuenta-mi-info .li-sub {
  font-size: 13px;
  color: var(--muted);
  margin-top: 2px;
}
```

- [ ] **Step 4: Verificar visualmente que el ícono y el panel vacío abren/cierran**

Antes de completar este step hay que cablear la apertura/cierre en JS (Task 8, Step 3) — si se quiere verificar el HTML/CSS de forma aislada, abrir el panel manualmente desde la consola del navegador: `document.getElementById('cuenta-panel').classList.add('show')`.

Expected: aparece un ícono 👤 junto al botón "Salir" en el topbar. Al forzar `classList.add('show')` se ve el panel fullscreen con header "Mi cuenta", la tarjeta de info (vacía, "—"), el formulario de cambio de contraseña con sus tres campos y el botón "Cambiar contraseña". Al tocar ✕ (una vez cableado en Task 8) el panel se cierra.

---

### Task 8: JS — abrir/cerrar el panel y cambiar mi contraseña

**Files:**
- Modify: `app.js` (agregar sección nueva "Mi cuenta" después de la sección "Reportes" — es decir, después de `initReportes()` línea 1422 y antes de `// ---------- Init ----------` línea 1424)
- Modify: `app.js:1426-1436` (`init()` — agregar `initCuenta();`)

**Interfaces:**
- Consumes: `supabase`, `toast()`, `getSession()`, `assertOnline()` — todos ya definidos en `app.js`. `cambiar_contrasena()` de Task 3.
- Produces: `openCuentaPanel()`, `closeCuentaPanel()`, `guardarPasswordPropia()`, `initCuenta()` — Task 10 extiende `openCuentaPanel()` para además cargar la sección "Usuarios" cuando el rol es admin.

- [ ] **Step 1: Agregar la sección "Mi cuenta" en `app.js`**

Insertar antes de `// ---------- Init ----------`:

```js
// ---------- Mi cuenta ----------

function openCuentaPanel() {
  const session = getSession();
  document.getElementById('cuenta-mi-nombre').textContent = session.nombre;
  document.getElementById('cuenta-mi-rol').textContent =
    session.rol === 'admin' ? 'Gerente' : 'Vendedor';
  document.getElementById('cuenta-password-actual').value = '';
  document.getElementById('cuenta-password-nueva').value = '';
  document.getElementById('cuenta-password-confirmar').value = '';
  document.getElementById('cuenta-password-error').textContent = '';
  document.getElementById('cuenta-panel').classList.add('show');
}

function closeCuentaPanel() {
  document.getElementById('cuenta-panel').classList.remove('show');
}

async function guardarPasswordPropia() {
  if (!assertOnline()) return;

  const actual = document.getElementById('cuenta-password-actual').value;
  const nueva = document.getElementById('cuenta-password-nueva').value;
  const confirmar = document.getElementById('cuenta-password-confirmar').value;
  const errorEl = document.getElementById('cuenta-password-error');
  const btn = document.getElementById('cuenta-password-guardar');

  errorEl.textContent = '';

  if (!actual || !nueva || !confirmar) {
    errorEl.textContent = 'Llena los tres campos.';
    return;
  }

  if (nueva !== confirmar) {
    errorEl.textContent = 'La nueva contraseña y su confirmación no coinciden.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    const session = getSession();
    const { error } = await supabase.rpc('cambiar_contrasena', {
      p_usuario_id: session.id,
      p_password_actual: actual,
      p_password_nueva: nueva,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('PASSWORD_ACTUAL_INCORRECTA')) {
        errorEl.textContent = 'La contraseña actual no es correcta.';
      } else {
        errorEl.textContent = 'No se pudo cambiar la contraseña. Intenta de nuevo.';
      }
      return;
    }

    document.getElementById('cuenta-password-actual').value = '';
    document.getElementById('cuenta-password-nueva').value = '';
    document.getElementById('cuenta-password-confirmar').value = '';
    toast('Contraseña actualizada.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Cambiar contraseña';
  }
}

function initCuenta() {
  document.getElementById('btn-mi-cuenta').addEventListener('click', openCuentaPanel);
  document.getElementById('cuenta-cerrar').addEventListener('click', closeCuentaPanel);
  document.getElementById('cuenta-password-guardar').addEventListener('click', guardarPasswordPropia);
}
```

- [ ] **Step 2: Registrar `initCuenta()` en `init()`**

En `function init()`, agregar junto a las demás `init*`:

```js
  initCuenta();
```

- [ ] **Step 3: Verificar en el navegador**

Iniciar sesión como cualquier usuario, tocar el ícono 👤 en el topbar.

Expected: se abre el panel "Mi cuenta" mostrando el nombre y rol de la sesión actual. Intentar guardar con campos vacíos → error "Llena los tres campos.". Poner nueva y confirmar distintas → error de no coincidencia. Poner la contraseña actual incorrecta → "La contraseña actual no es correcta.". Poner todo correcto → toast "Contraseña actualizada.", los campos se limpian. Cerrar sesión y volver a entrar con la nueva contraseña → funciona. Tocar ✕ cierra el panel.

---

### Task 9: Scaffold de la sección "Usuarios" (HTML + CSS, solo admin)

**Files:**
- Modify: `index.html` (reemplazar el placeholder `#cuenta-usuarios-seccion` de Task 7 con el contenido real: lista de usuarios + bottom sheet de alta/edición)
- Modify: `styles.css` (agregar estilos nuevos al final)

**Interfaces:**
- Consumes: `.li-badge.al-dia`/`.li-badge.pendiente`, `.list`, `.list-item`, `.sheet-overlay`, `.sheet`, `.toggle-group`, `.toggle-btn`, `.field`, `.error-msg`, `.sheet-actions`, `.btn-outline`, `.btn-primary` (todas ya existentes en `styles.css`).
- Produces: `#cuenta-usuarios-list`, `#btn-nuevo-usuario` (botón + dentro de la propia sección, no un FAB flotante — ver Step 1), `#usuario-sheet`, `#usuario-form-title`, `#usuario-nombre`, `#usuario-rol-toggle` (`button[data-rol]`), `#usuario-password`, `#usuario-password-label`, `#usuario-form-error`, `#usuario-cancelar`, `#usuario-guardar`, `#usuario-activo-row`, `#usuario-activo-toggle` — IDs que Task 10 usa desde `app.js`.

- [ ] **Step 1: Reemplazar el placeholder de la sección "Usuarios" en `index.html`**

Reemplazar:

```html
      <div id="cuenta-usuarios-seccion" style="display:none;">
        <!-- Task 9 agrega aquí la sección "Usuarios" (solo admin) -->
      </div>
```

por:

```html
      <div id="cuenta-usuarios-seccion" style="display:none;">
        <div class="cuenta-usuarios-header">
          <h3 class="fs-subtitle" style="margin:20px 0 0;">Usuarios</h3>
          <button id="btn-nuevo-usuario" type="button" class="btn btn-outline btn-nuevo-usuario">+ Nuevo</button>
        </div>
        <div id="cuenta-usuarios-list" class="list"></div>
      </div>
```

- [ ] **Step 2: Agregar el bottom sheet `#usuario-sheet`**

En `index.html`, después del cierre de `#producto-sheet` (junto a los otros `*-sheet`):

```html
  <!-- ============ Formulario usuario (bottom sheet) ============ -->
  <div id="usuario-sheet" class="sheet-overlay">
    <div class="sheet">
      <h3 id="usuario-form-title">Nuevo usuario</h3>
      <div class="field">
        <label for="usuario-nombre">Nombre</label>
        <input id="usuario-nombre" type="text" placeholder="Ej. Karla" />
      </div>
      <div class="field">
        <label>Rol</label>
        <div class="toggle-group" id="usuario-rol-toggle">
          <button type="button" class="toggle-btn active" data-rol="vendedor">Vendedor</button>
          <button type="button" class="toggle-btn" data-rol="admin">Admin</button>
        </div>
      </div>
      <div class="field">
        <label id="usuario-password-label" for="usuario-password">Contraseña inicial</label>
        <input id="usuario-password" type="password" autocomplete="off" />
      </div>
      <div class="field" id="usuario-activo-row" style="display:none;">
        <label>Estatus</label>
        <div class="toggle-group" id="usuario-activo-toggle">
          <button type="button" class="toggle-btn active" data-activo="true">Activo</button>
          <button type="button" class="toggle-btn" data-activo="false">Inactivo</button>
        </div>
      </div>
      <p id="usuario-form-error" class="error-msg"></p>
      <div class="sheet-actions">
        <button id="usuario-cancelar" type="button" class="btn btn-outline">Cancelar</button>
        <button id="usuario-guardar" type="button" class="btn btn-primary">Guardar</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Agregar los estilos nuevos al final de `styles.css`**

```css
.cuenta-usuarios-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.btn-nuevo-usuario {
  width: auto;
  padding: 8px 14px;
  font-size: 13px;
}

.list-item.usuario-inactivo {
  opacity: 0.55;
}
```

- [ ] **Step 4: Verificar visualmente (sin datos reales todavía)**

Con sesión de admin, abrir "Mi cuenta" y forzar en consola `document.getElementById('cuenta-usuarios-seccion').style.display = 'block'`.

Expected: aparece el encabezado "Usuarios" con el botón "+ Nuevo" y una lista vacía debajo. Forzar `document.getElementById('usuario-sheet').classList.add('show')` debe mostrar el bottom sheet con nombre, toggle Vendedor/Admin, campo de contraseña, y el toggle de Activo/Inactivo oculto (`display:none`, se muestra solo en modo edición vía Task 10).

---

### Task 10: JS — listar, dar de alta, editar y cambiar estatus de usuarios (solo admin)

**Files:**
- Modify: `app.js` (extender la sección "Mi cuenta" de Task 8: agregar `loadUsuarios()`, `renderUsuarios()`, `openUsuarioForm()`, `closeUsuarioForm()`, `saveUsuario()`, y ampliar `openCuentaPanel()`/`initCuenta()`)

**Interfaces:**
- Consumes: `crear_usuario()` (Task 2), `admin_resetear_password()` (Task 4), `cambiar_estatus_usuario()` (Task 5), `escapeHtml()`, `escapeAttr()`, `assertOnline()`, `getSession()`, `toast()` — todos ya definidos.
- Produces: extiende `openCuentaPanel()` para mostrar/ocultar `#cuenta-usuarios-seccion` según rol y disparar `loadUsuarios()`.

- [ ] **Step 1: Ampliar `openCuentaPanel()` para cargar la sección "Usuarios" si el rol es admin**

Reemplazar la función `openCuentaPanel()` de Task 8 por:

```js
function openCuentaPanel() {
  const session = getSession();
  document.getElementById('cuenta-mi-nombre').textContent = session.nombre;
  document.getElementById('cuenta-mi-rol').textContent =
    session.rol === 'admin' ? 'Gerente' : 'Vendedor';
  document.getElementById('cuenta-password-actual').value = '';
  document.getElementById('cuenta-password-nueva').value = '';
  document.getElementById('cuenta-password-confirmar').value = '';
  document.getElementById('cuenta-password-error').textContent = '';

  const seccionUsuarios = document.getElementById('cuenta-usuarios-seccion');
  if (session.rol === 'admin') {
    seccionUsuarios.style.display = 'block';
    loadUsuarios();
  } else {
    seccionUsuarios.style.display = 'none';
  }

  document.getElementById('cuenta-panel').classList.add('show');
}
```

- [ ] **Step 2: Agregar `loadUsuarios()` y `renderUsuarios()`**

Insertar después de `initCuenta()` (dentro de la sección "Mi cuenta"):

```js
let usuariosCache = [];
let usuarioEditId = null;

async function loadUsuarios() {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nombre, rol, activo')
    .order('nombre');

  if (error) {
    toast('No se pudo cargar la lista de usuarios.', 'error');
    return;
  }

  usuariosCache = data || [];
  renderUsuarios();
}

function renderUsuarios() {
  const list = document.getElementById('cuenta-usuarios-list');
  list.innerHTML = '';

  usuariosCache.forEach((u) => {
    const card = document.createElement('div');
    card.className = 'list-item' + (u.activo ? '' : ' usuario-inactivo');
    card.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(u.nombre)}</div>
        <div class="li-sub">${u.rol === 'admin' ? 'Admin' : 'Vendedor'}</div>
      </div>
      <div class="li-badge ${u.activo ? 'al-dia' : 'pendiente'}">${u.activo ? 'Activo' : 'Inactivo'}</div>
    `;
    card.addEventListener('click', () => openUsuarioForm(u));
    list.appendChild(card);
  });
}
```

- [ ] **Step 3: Agregar `openUsuarioForm()` / `closeUsuarioForm()`**

```js
function openUsuarioForm(usuario) {
  usuarioEditId = usuario ? usuario.id : null;
  document.getElementById('usuario-form-title').textContent =
    usuario ? 'Editar usuario' : 'Nuevo usuario';
  document.getElementById('usuario-nombre').value = usuario ? usuario.nombre : '';
  document.getElementById('usuario-password').value = '';
  document.getElementById('usuario-password-label').textContent =
    usuario ? 'Nueva contraseña (opcional)' : 'Contraseña inicial';
  document.getElementById('usuario-form-error').textContent = '';

  const rolInicial = usuario ? usuario.rol : 'vendedor';
  document.querySelectorAll('#usuario-rol-toggle .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.rol === rolInicial);
  });

  const activoRow = document.getElementById('usuario-activo-row');
  if (usuario) {
    activoRow.style.display = 'block';
    document.querySelectorAll('#usuario-activo-toggle .toggle-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.activo === String(usuario.activo));
    });
  } else {
    activoRow.style.display = 'none';
  }

  document.getElementById('usuario-sheet').classList.add('show');
}

function closeUsuarioForm() {
  document.getElementById('usuario-sheet').classList.remove('show');
  usuarioEditId = null;
}
```

- [ ] **Step 4: Agregar `saveUsuario()`**

```js
async function saveUsuario() {
  if (!assertOnline()) return;

  const nombre = document.getElementById('usuario-nombre').value.trim();
  const password = document.getElementById('usuario-password').value;
  const rol = document.querySelector('#usuario-rol-toggle .toggle-btn.active').dataset.rol;
  const errorEl = document.getElementById('usuario-form-error');
  const saveBtn = document.getElementById('usuario-guardar');

  errorEl.textContent = '';

  if (!nombre) {
    errorEl.textContent = 'El nombre es obligatorio.';
    return;
  }

  if (!usuarioEditId && !password) {
    errorEl.textContent = 'La contraseña inicial es obligatoria.';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

  try {
    const session = getSession();

    if (!usuarioEditId) {
      const { error } = await supabase.rpc('crear_usuario', {
        p_nombre: nombre,
        p_password: password,
        p_rol: rol,
      });

      if (error) {
        if (error.code === '23505') {
          errorEl.textContent =
            'Ya existe un usuario con ese nombre. Si es una persona distinta, diferéncialo ' +
            'con un apodo o inicial.';
        } else {
          errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
        }
        return;
      }

      toast('Usuario agregado.');
    } else {
      const { error: updateError } = await supabase
        .from('usuarios')
        .update({ nombre, rol })
        .eq('id', usuarioEditId);

      if (updateError) {
        if (updateError.code === '23505') {
          errorEl.textContent = 'Ya existe un usuario con ese nombre.';
        } else {
          errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
        }
        return;
      }

      if (password) {
        const { error: passError } = await supabase.rpc('admin_resetear_password', {
          p_admin_id: session.id,
          p_usuario_id: usuarioEditId,
          p_password_nueva: password,
        });
        if (passError) {
          errorEl.textContent = 'El usuario se guardó, pero no se pudo cambiar la contraseña.';
          return;
        }
      }

      const activoBtn = document.querySelector('#usuario-activo-toggle .toggle-btn.active');
      const activoNuevo = activoBtn.dataset.activo === 'true';
      const { error: estatusError } = await supabase.rpc('cambiar_estatus_usuario', {
        p_admin_id: session.id,
        p_usuario_id: usuarioEditId,
        p_activo: activoNuevo,
      });

      if (estatusError) {
        const msg = estatusError.message || '';
        if (msg.includes('ULTIMO_ADMIN')) {
          errorEl.textContent =
            'No puedes desactivar al único admin activo — activa a otro admin primero.';
        } else {
          errorEl.textContent = 'No se pudo actualizar el estatus.';
        }
        return;
      }

      toast('Usuario actualizado.');
    }

    closeUsuarioForm();
    loadUsuarios();
    populateLoginUsuarios();
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar';
  }
}
```

- [ ] **Step 5: Cablear los toggles y los botones del sheet, extender `initCuenta()`**

Agregar antes de `saveUsuario` (o después, el orden entre funciones no importa) el manejo de los toggles, y ampliar `initCuenta()`:

```js
function initCuenta() {
  document.getElementById('btn-mi-cuenta').addEventListener('click', openCuentaPanel);
  document.getElementById('cuenta-cerrar').addEventListener('click', closeCuentaPanel);
  document.getElementById('cuenta-password-guardar').addEventListener('click', guardarPasswordPropia);

  document.getElementById('btn-nuevo-usuario').addEventListener('click', () => openUsuarioForm(null));
  document.getElementById('usuario-cancelar').addEventListener('click', closeUsuarioForm);
  document.getElementById('usuario-guardar').addEventListener('click', saveUsuario);

  document.querySelectorAll('#usuario-rol-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#usuario-rol-toggle .toggle-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.querySelectorAll('#usuario-activo-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#usuario-activo-toggle .toggle-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}
```

Esta reemplaza la versión de `initCuenta()` agregada en Task 8, Step 1 (mismo nombre de función, cuerpo ampliado).

- [ ] **Step 6: Verificar en el navegador — alta de usuario**

Entrar como "Papá" (admin), abrir "Mi cuenta", confirmar que aparece la sección "Usuarios" con los 4 usuarios reales (con badge "Activo" en verde). Tocar "+ Nuevo", llenar nombre "Prueba QA", dejar rol en Vendedor, poner contraseña "prueba123", guardar.

Expected: toast "Usuario agregado.", el nuevo usuario aparece en la lista con badge "Activo". Cerrar sesión y confirmar que "Prueba QA" ya aparece en el `<select>` de login. Entrar con "Prueba QA" / "prueba123" → funciona.

- [ ] **Step 7: Verificar nombre duplicado**

Como admin, intentar dar de alta otro usuario con nombre "Prueba QA".

Expected: error "Ya existe un usuario con ese nombre..." — no se crea una fila duplicada (confirmar en la lista que sigue habiendo solo un "Prueba QA").

- [ ] **Step 8: Verificar edición — cambio de rol y reseteo de contraseña sin conocer la anterior**

Tocar la card de "Prueba QA", cambiar el rol a Admin, escribir una nueva contraseña "prueba456" en el campo (opcional), guardar.

Expected: toast "Usuario actualizado.", en la lista ahora muestra "Admin". Cerrar sesión, entrar como "Prueba QA" con "prueba456" → funciona. Con "prueba123" (la anterior) → falla.

- [ ] **Step 9: Verificar desactivación y reactivación**

Editar "Prueba QA" de nuevo, cambiar el toggle de Estatus a "Inactivo", guardar.

Expected: toast de éxito, la card se ve atenuada con badge "Inactivo" en rojo. Cerrar sesión → "Prueba QA" ya no aparece en el `<select>` de login. Intentar loguear manualmente con `supabase.rpc('login_usuario', {p_nombre:'Prueba QA', p_password:'prueba456'})` desde la consola del navegador (con sesión cerrada) → regresa arreglo vacío. Volver a activarlo desde otra cuenta admin (o reactivar directo en Supabase si "Prueba QA" era el único admin activo — ver Step 10) y confirmar que reaparece en el login.

- [ ] **Step 10: Verificar la salvaguarda del último admin desde la UI**

Con solo "Papá" y "Prueba QA" (ahora admin, si sigue así del Step 8) como admins activos, editar a "Papá" e intentar poner su Estatus en Inactivo.

Expected: error "No puedes desactivar al único admin activo — activa a otro admin primero." **solo si "Prueba QA" ya está inactivo** (Step 9) — si "Prueba QA" sigue activo y es admin, la desactivación de "Papá" sí se permitiría (hay un segundo admin activo); en ese caso, primero desactivar a "Prueba QA" para dejar a "Papá" como único admin activo y repetir la prueba. Al final de este step, dejar a "Papá" activo y borrar/desactivar "Prueba QA" para no ensuciar el catálogo real de usuarios (ver Task 11, Step 1).

- [ ] **Step 11: Verificar que un vendedor no ve la sección "Usuarios"**

Cerrar sesión, entrar como "Angie" (o cualquier vendedor), abrir "Mi cuenta".

Expected: solo se ve la sección "Mi cuenta" (info + cambio de contraseña) — la sección "Usuarios" no aparece en absoluto.

- [ ] **Step 12: Verificar que un admin ya puede vender sin cambios (regresión, no código nuevo)**

Entrar como "Papá", registrar una venta de contado normal desde "Nueva venta".

Expected: la venta se registra exactamente igual que con cualquier otro usuario — sin ningún error ni comportamiento distinto por ser admin (confirma lo documentado en el diseño ticket 12 sección 1.7: no requiere cambio de código).

---

### Task 11: Limpieza de datos de prueba, regresión completa y cierre del ticket

**Files:**
- Modify: `sw.js:1` (`CACHE = 'vf-v4'` → `'vf-v5'`)
- Modify: `TICKETS.md` (marcar el ticket 12 con los checkboxes completados y agregar el bloque "Estado", mismo formato que los tickets 01-11)

**Interfaces:**
- Consumes: ninguna nueva — este task es de verificación, limpieza y documentación.
- Produces: `sw.js`, `TICKETS.md` actualizados, listos para desbloquear el ticket 13.

- [ ] **Step 1: Confirmar que no quedó ningún usuario de prueba en el catálogo real**

```sql
select nombre, rol, activo from usuarios order by nombre;
```

Expected: únicamente los usuarios reales del negocio (Papá como admin activo, Angie/Alexa/Alexis, y cualquier usuario real que Luis haya dado de alta durante las pruebas de la Task 10 y quiera conservar). Si queda algún "Prueba QA"/"Test ..." de las tasks anteriores, eliminarlo:

```sql
delete from usuarios where nombre like 'Test %' or nombre = 'Prueba QA';
```

- [ ] **Step 2: Bump de caché en `sw.js`**

```js
const CACHE = 'vf-v5';
```

- [ ] **Step 3: Regresión rápida sobre los módulos existentes**

Repetir brevemente los flujos ya cubiertos por tickets anteriores (login, venta de contado, venta a crédito, abono, anular, historial, reportes) para confirmar que la gestión de usuarios no rompió nada.

Expected: sin regresiones — todos los flujos previos siguen funcionando exactamente igual. El `<select>` de login sigue reflejando los usuarios activos reales.

- [ ] **Step 4: Actualizar `TICKETS.md`**

Reemplazar el bloque del ticket 12 (buscar `## 12` en el archivo) por:

```markdown
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
Probado en navegador y con `execute_sql`: alta de usuario funciona de
inmediato para login, nombre duplicado bloqueado con mensaje claro,
autoservicio de contraseña valida la actual y el match de confirmación,
reseteo por admin no requiere la contraseña anterior, desactivar oculta del
login sin borrar el historial de ventas/abonos pasado, reactivar lo regresa,
salvaguarda del último admin activo bloquea quedarse sin nadie que gestione
usuarios, vendedor no ve la sección "Usuarios", admin ya podía vender sin
cambios (confirmado, no requirió código nuevo).

- [x] Solo `admin` gestiona usuarios (puede haber varios); baja = desactivar
      (`usuarios.activo`), nunca borrar — reactivable
- [x] Salvaguarda: nunca se permite desactivar al último admin activo
- [x] Contraseña: autoservicio (requiere la actual) + reseteo directo por
      admin (sin requerir la anterior)
- [x] Pantalla "Mi cuenta" nueva, accesible desde ícono en topbar — todos ven
      cambio de contraseña; solo admin ve gestión de usuarios
- [x] Login poblado dinámicamente desde `usuarios where activo = true`
- [x] Confirmado sin cambio de código: un admin ya puede vender hoy
```

- [ ] **Step 5: Confirmar el resultado leyendo el archivo**

Releer `TICKETS.md` completo y confirmar que el ticket 12 quedó con el mismo formato visual (✅ en el título, bloque **Estado**, checkboxes marcados) que los tickets anteriores, y que la sección "Progreso" de `CLAUDE.md` se actualiza para mover el ticket 12 de pendiente a completado y anotar que el ticket 13 ya no está bloqueado.

- [ ] **Step 6: Subir los cambios**

```powershell
cd "C:\Users\DELL\Documents\IA-Claude- Proyecto MPM\PWA - Aplicaciones\Ventas Familia"
git add -A
git commit -m "Ticket 12: Gestión de usuarios — alta, edición, desactivación y contraseñas"
git push
```
