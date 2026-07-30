# Diseño — Ticket 12: Gestión de usuarios

> Ver [SPEC.md](../../../SPEC.md) sección 1 (usuarios y roles) para el contexto
> original — hasta ahora los 4 usuarios eran una lista fija sembrada en
> Supabase y escrita también en el `<select>` de login. Este documento agrega
> la posibilidad de dar de alta, editar, desactivar/reactivar usuarios y
> manejar contraseñas desde la propia app, sin tocar código ni Supabase a
> mano. Es el primero de dos sub-proyectos (el segundo es inventario
> multi-almacén, que depende de que los usuarios ya se gestionen desde aquí).

## 1. Contexto y decisiones tomadas en esta sesión

1. **Quién gestiona usuarios:** solo el rol `admin`. Un `vendedor` no ve la
   sección de gestión de usuarios (sí ve y usa su propia sección de "Mi
   cuenta" para cambiar su contraseña).
2. **Puede haber varios admins:** el rol se elige libremente al crear o
   editar un usuario (`admin` o `vendedor`), no está reservado a una sola
   persona.
3. **Baja = desactivar, nunca borrar:** mismo patrón que ventas/abonos/
   clientes en este proyecto. Un usuario desactivado (`activo = false`):
   - Deja de aparecer en el `<select>` de login (no puede iniciar sesión
     aunque conozca su contraseña — bloqueado también server-side en
     `login_usuario()`, no solo ocultando la opción en el UI).
   - Deja de aparecer como opción elegible en cualquier lugar donde se elija
     "vendedor" (no aplica hoy — `vendedor_id` siempre es quien está
     logueado, nunca un campo elegible).
   - **Conserva** todo su historial de ventas/abonos pasados intacto — su
     nombre sigue apareciendo en Historial y Reportes exactamente igual que
     antes de desactivarlo.
   - Se puede **reactivar** después (toggle Activo/Inactivo, reversible).
4. **Contraseñas — dos vías:**
   - **Autoservicio:** cualquier usuario logueado puede cambiar la suya
     desde "Mi cuenta", debe escribir la actual + la nueva dos veces.
   - **Reseteo por admin:** el admin puede asignarle una contraseña nueva a
     cualquier usuario desde la pantalla de edición, sin necesidad de saber
     la anterior (cubre "se me olvidó" — este login no tiene recuperación
     por correo).
5. **Alta de usuario:** nombre (único, mismo mensaje de apodo/inicial que ya
   usa `clientes` si hay duplicado) + contraseña inicial (la asigna el
   admin, no hay invitación por correo) + rol.
6. **Ubicación en la UI:** pantalla nueva **"Mi cuenta"**, que no existe hoy
   en esta app — se agrega un ícono en el topbar (junto a "Salir") que abre
   un panel de pantalla completa. Todos ven su propio nombre/rol y el
   cambio de contraseña; solo si `session.rol === 'admin'` aparece además la
   sección de gestión de usuarios.
7. **Vender ya funciona igual para todos:** `registrar_venta()` usa
   `vendedor_id = session.id` sin distinguir rol — un admin ya puede vender
   hoy sin ningún cambio de código. Se confirma explícitamente para que
   quede documentado, no porque haya que tocar la función.
8. **Salvaguarda agregada por diseño (no fue una pregunta explícita):**
   nunca se permite desactivar al **último admin activo** — ni a sí mismo ni
   a otro admin si es el único que queda. Sin esto, la app podría quedar sin
   nadie capaz de gestionar usuarios. Se bloquea con mensaje claro en vez de
   permitirlo silenciosamente.

## 2. Esquema — cambios en Supabase

```sql
alter table usuarios add column activo boolean not null default true;
```

Ninguna otra tabla cambia. `usuarios.nombre` ya es `unique` desde ticket 01
— el alta de usuario reutiliza ese constraint tal cual (mismo patrón de
error 23505 que ya maneja `saveCliente()`).

**Nota de consistencia:** editar `nombre`/`rol` de un usuario existente es
un `update` directo desde el cliente (no toca contraseña, mismo patrón ya
usado en `clientes`/`productos`). Cambiar `activo` **nunca** es un update
directo — siempre pasa por `cambiar_estatus_usuario()` (sección 3), porque
ahí vive la salvaguarda del último admin. El frontend nunca debe hacer
`update({ activo })` directamente sobre `usuarios`.

## 3. Funciones SQL nuevas

### `crear_usuario(p_nombre text, p_password text, p_rol text)`

`SECURITY DEFINER`, mismo patrón que el resto de funciones de escritura de
la app.

1. Valida `p_rol in ('admin', 'vendedor')` → si no, `raise exception
   'ROL_INVALIDO'`.
2. Valida `p_nombre` y `p_password` no vacíos → `raise exception
   'DATOS_INVALIDOS'`.
3. Inserta en `usuarios (nombre, rol, password_hash, activo)` con
   `password_hash = crypt(p_password, gen_salt('bf'))`, `activo = true`.
4. Si viola el `unique` de `nombre` → deja que el error 23505 de Postgres
   se propague (el frontend ya sabe mapear ese código, mismo patrón que
   `saveCliente()`).
5. Devuelve `id, nombre, rol`.

### `cambiar_contrasena(p_usuario_id uuid, p_password_actual text, p_password_nueva text)`

1. Verifica que exista el usuario y que `crypt(p_password_actual,
   password_hash) = password_hash` → si no coincide, `raise exception
   'PASSWORD_ACTUAL_INCORRECTA'`.
2. Valida `p_password_nueva` no vacía → `raise exception
   'PASSWORD_INVALIDA'`.
3. Actualiza `password_hash = crypt(p_password_nueva, gen_salt('bf'))`.

### `admin_resetear_password(p_admin_id uuid, p_usuario_id uuid, p_password_nueva text)`

1. Verifica que `p_admin_id` corresponda a un usuario con `rol = 'admin'` y
   `activo = true` → si no, `raise exception 'PERMISO_DENEGADO'`.
2. Valida `p_password_nueva` no vacía → `raise exception
   'PASSWORD_INVALIDA'`.
3. Actualiza `password_hash` del `p_usuario_id` objetivo, sin pedir la
   anterior.

### `cambiar_estatus_usuario(p_admin_id uuid, p_usuario_id uuid, p_activo boolean)`

Encapsula la salvaguarda del "último admin" (más seguro hacerlo aquí que
confiar en que el frontend nunca mande la desactivación equivocada):

1. Verifica que `p_admin_id` sea admin activo → si no, `PERMISO_DENEGADO`.
2. Si `p_activo = false`: cuenta cuántos `usuarios` tienen
   `rol = 'admin' and activo = true and id <> p_usuario_id`. Si ese conteo
   es `0` y el usuario objetivo es admin → `raise exception
   'ULTIMO_ADMIN'` (no se puede desactivar al único admin que queda).
3. Actualiza `activo = p_activo` en `p_usuario_id`.

### `login_usuario()` (rework — un solo cambio)

Agrega `and u.activo = true` al `where` existente — un usuario desactivado
nunca recibe una fila de vuelta, sin importar si la contraseña es correcta.

## 4. Frontend

### Login (`index.html` + `app.js`)

- El `<select id="login-nombre">` de opciones fijas se reemplaza por uno
  vacío, poblado en tiempo de carga desde
  `supabase.from('usuarios').select('nombre').eq('activo', true).order('nombre')`.
- Sin cambios en `handleLogin()` más allá de que la lista ya no es
  hardcodeada.

### Topbar — nuevo ícono "Mi cuenta"

- Ícono de persona junto al botón "Salir" existente en `#view-main
  .topbar`, abre `#cuenta-panel` (mismo patrón `fullscreen-overlay` que
  `venta-panel`/`historial-panel`).

### Panel "Mi cuenta" (`#cuenta-panel`)

- **Sección "Mi cuenta"** (todos los roles):
  - Nombre y rol de la sesión actual (solo lectura).
  - Formulario "Cambiar mi contraseña": contraseña actual, nueva,
    confirmar nueva (valida que las dos últimas coincidan en el cliente
    antes de llamar `cambiar_contrasena`).
- **Sección "Usuarios"** (solo si `session.rol === 'admin'`):
  - Lista de todos los usuarios (activos e inactivos), con badge
    Activo/Inactivo por fila (mismo patrón visual que
    `li-badge.al-dia`/`li-badge.pendiente`).
  - Botón (+) abre bottom sheet de alta: nombre, contraseña inicial,
    selector de rol (admin/vendedor) → `crear_usuario()`.
  - Tocar un usuario existente abre el mismo bottom sheet en modo edición:
    nombre, rol, un campo opcional "Nueva contraseña" (si se llena, llama
    `admin_resetear_password`; si se deja vacío, no se toca la contraseña),
    y un toggle Activo/Inactivo → `cambiar_estatus_usuario()`.

## 5. Mapeo de errores (frontend)

| Código | Mensaje al usuario |
|---|---|
| `23505` (alta de usuario, nombre duplicado) | "Ya existe un usuario con ese nombre." |
| `ROL_INVALIDO` / `DATOS_INVALIDOS` / `PASSWORD_INVALIDA` | "Revisa los datos del formulario." |
| `PASSWORD_ACTUAL_INCORRECTA` | "La contraseña actual no es correcta." |
| `PERMISO_DENEGADO` | "No tienes permiso para hacer esto." |
| `ULTIMO_ADMIN` | "No puedes desactivar al único admin activo — activa a otro admin primero." |

## 6. Casos de prueba

- Login: el `<select>` refleja exactamente los usuarios `activo = true` en
  Supabase — agregar uno nuevo lo hace aparecer sin tocar código;
  desactivar uno lo hace desaparecer.
- Un usuario desactivado no puede iniciar sesión aunque escriba la
  contraseña correcta (rechazado por `login_usuario()`, no solo oculto en
  el UI).
- Admin crea un usuario nuevo (vendedor) → puede iniciar sesión de
  inmediato con la contraseña asignada.
- Admin crea un usuario con nombre duplicado → bloqueado con mensaje claro,
  no se crea una fila parcial.
- Un vendedor cambia su propia contraseña con la actual correcta → puede
  volver a entrar con la nueva; con la actual incorrecta → bloqueado.
- Admin resetea la contraseña de otro usuario sin saber la anterior → ese
  usuario entra con la nueva contraseña.
- Admin desactiva a un vendedor → ese vendedor ya no aparece en login;
  ventas/abonos que ya hizo siguen mostrando su nombre en Historial y
  Reportes sin cambios.
- Admin reactiva a un usuario previamente desactivado → vuelve a aparecer
  en login.
- Admin intenta desactivarse a sí mismo siendo el único admin activo →
  bloqueado con `ULTIMO_ADMIN`. Si hay un segundo admin activo, sí se
  permite.
- Un vendedor no ve la sección "Usuarios" dentro de "Mi cuenta" (solo ve su
  propio cambio de contraseña).
- Un admin ya puede registrar una venta a su nombre sin ningún cambio
  (verificación de regresión, no de código nuevo).

## 7. Fuera de alcance (explícito)

- Recuperación de contraseña por correo/SMS — no existe Supabase Auth real
  en este proyecto (SPEC sección 1), el reseteo siempre pasa por el admin.
- Políticas de complejidad de contraseña (longitud mínima, caracteres
  especiales, etc.) — se valida solo que no esté vacía, igual que el resto
  de validaciones simples de esta app.
- Invitaciones o notificación automática al usuario nuevo de su contraseña
  — el admin se la comunica manualmente (mensaje, de viva voz, etc.).
- Historial/auditoría de cambios de contraseña o de quién editó a quién —
  no se pidió y no aporta valor a una app de 4-6 personas de confianza.
