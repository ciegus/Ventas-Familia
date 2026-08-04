# Diseño — Ticket 17: Auth real de Supabase + RLS en las 11 tablas

> Origen: hallazgo crítico de [PROJECT_AUDIT.md](../../../PROJECT_AUDIT.md) sección 8 — con
> RLS deshabilitado en las 11 tablas y la clave `anon` embebida en `app.js`, cualquiera con
> esa clave lee/escribe cualquier tabla directo por REST, evitando por completo las 17
> funciones `SECURITY DEFINER` que hoy validan permisos. Decisión de Luis (2026-08-03):
> cerrar esto migrando a Supabase Auth real (no solo bloquear escrituras directas), aunque
> sea un cambio más grande, y probar los pasos directo en producción con cuidado (no existe
> un ambiente de staging — deuda técnica #6 del audit).
>
> **Este documento es el diseño. No se ha tocado ni una migración de esquema todavía** —
> antes de ejecutar, Luis debe confirmar en concreto las decisiones de la sección 1
> (sobre todo: el reseteo de contraseña de los 5 usuarios reales y la Edge Function nueva).

## 1. Contexto y decisiones que necesitan confirmación explícita

Esta app no usa Supabase Auth — usa una función propia (`login_usuario`) con hash bcrypt en
una columna de `usuarios`. Postgres/RLS no puede distinguir "esto lo pidió Angie" de "esto
lo pidió Luis" porque toda petición llega como el mismo rol `anon`, sin JWT verificado por
persona. Migrar a Auth real cambia eso: cada sesión trae un JWT firmado por Supabase con el
`uid` del usuario real, verificable tanto por RLS como por las funciones SQL vía `auth.uid()`.

**Decisiones de diseño que se proponen aquí y que Luis debe confirmar antes de ejecutar:**

1. **Identificador de Auth: correo sintético, no correo real.** Supabase Auth exige un
   identificador único (normalmente correo). El negocio decidió explícitamente no pedirle
   correo a cada persona (SPEC sección 1). Propuesta: generar un correo interno no real por
   usuario, ej. `luis-lima@ventasfamilia.internal` (slug del nombre + dominio inventado que
   nunca se usa para enviar nada). La pantalla de login sigue siendo la misma de 3 pasos
   (categoría → nombre → contraseña) — el correo sintético es un detalle interno, nunca se
   le muestra a nadie ni se le pide que lo recuerde.
2. **Esto resetea la contraseña de los 5 usuarios reales.** Supabase Auth gestiona su
   propio hash de contraseña — no se puede "migrar" el bcrypt actual a su sistema interno.
   Cada uno de los 5 (Luis, Angie, Alexa, Alexis, Regina) va a necesitar una contraseña
   nueva el día del corte. Propuesta: el admin (Luis) asigna una contraseña temporal a cada
   quien al momento de la migración (vía script único, no Edge Function todavía — ver fase
   A) y se las comunica manualmente, igual que hoy se comunican las contraseñas iniciales.
   **Esto es un evento de un solo momento que hay que coordinar con las 4 personas más.**
3. **Gestión de usuarios (alta, reseteo de contraseña ajena, desactivar) necesita una
   Edge Function nueva.** Crear un usuario de Supabase Auth o resetearle la contraseña a
   otra persona requiere la Auth Admin API, que solo se puede llamar con la clave
   `service_role` — una clave que **nunca** puede vivir en el cliente (rompería toda esta
   migración si se expusiera). Hoy `crear_usuario()`/`admin_resetear_password()` son
   funciones SQL normales porque manejaban el hash a mano; con Auth real eso ya no es
   posible desde SQL. Esto agrega **la primera pieza de código servidor del proyecto**
   (hoy es 100% estático + Postgres) — una Edge Function de Supabase (Deno), desplegable
   por MCP/CLI, que valida que quien llama es admin (por su propio JWT) y luego usa
   `service_role` internamente para crear/resetear/desactivar. No es un build step del
   frontend, es compatible con "sin build step" (CLAUDE.md), pero sí es infraestructura
   nueva que no existía.
4. **Cambio de contraseña propia sí se queda 100% en el cliente**, sin Edge Function: se
   reautentica con `signInWithPassword(correo, actual)` para confirmar que la actual es
   correcta (mismo requisito de hoy) y luego `auth.updateUser({password: nueva})`.
5. **Desactivar un usuario pasa a ser doble candado:** se mantiene `usuarios.activo`
   (ya existe, lo leen las políticas RLS) **y además** la Edge Function llama
   `auth.admin.updateUserById(id, {ban_duration: 'none'|'876000h'})` para que un usuario
   desactivado ni siquiera pueda obtener una sesión válida de Supabase — no solo quede
   bloqueado por una política. Defensa en profundidad, no un requisito nuevo de negocio.
6. **"Todos ven todo" se mantiene igual** — las políticas RLS de `SELECT` se escriben para
   cualquier `authenticated` (sesión válida, sea quien sea), replicando la filosofía actual,
   no agregando restricciones por rol que hoy no existen.
7. **Las 4 tablas transaccionales con folio (`ventas`, `abonos`, `movimientos_almacen`,
   `pagos_consigna`) y sus dependientes (`venta_items`, `venta_pagos`, `stock_almacen`)
   pasan a ser de solo-lectura para el cliente vía RLS — todo `INSERT`/`UPDATE`/`DELETE`
   directo se bloquea, forzando que pase por las funciones `SECURITY DEFINER`** (que sí
   pueden escribir porque corren como el dueño de la función, no como `authenticated` — así
   es como Postgres maneja `SECURITY DEFINER`, no necesita una política explícita a su
   favor). `clientes` y `productos` sí tienen escritura directa hoy desde `app.js`
   (alta/edición de cliente, edición de producto) — se proponen políticas de escritura
   directa para `authenticated` en esas dos tablas nada más, porque no mueven dinero/stock
   y no se quiere reescribir esos dos flujos sin necesidad.

## 2. Esquema — cambios en Supabase

```sql
-- usuarios.id pasa a ser el mismo id que auth.users (no un uuid independiente)
alter table usuarios
  add column auth_id uuid references auth.users(id) on delete cascade;

-- password_hash se elimina SOLO al final de la fase C, cuando ya no hay ningún
-- usuario real dependiendo de login_usuario(). No se toca en fase A/B.
```

Se usa una columna `auth_id` nueva (no reemplazar `usuarios.id` de una) para poder tener
las dos rutas de login funcionando en paralelo durante la migración (fase A/B) sin romper
sesiones activas ni referencias de `vendedor_id`/`cliente_id`/etc. que ya apuntan al
`usuarios.id` actual en 40+ filas de `movimientos_almacen` y el resto del historial. Al
cerrar fase C, `auth_id` pasa a ser la única identidad real (`usuarios.id` deja de
importar para nuevos usuarios, pero el historial existente no se toca — no hace falta
reescribir FKs).

## 3. RLS — políticas propuestas

Patrón repetido en las 9 tablas "protegidas" (todo menos `clientes`/`productos`):

```sql
alter table ventas enable row level security;

create policy ventas_select_authenticated on ventas
  for select to authenticated using (true);

-- Sin política de insert/update/delete para authenticated ni anon =
-- solo las funciones SECURITY DEFINER pueden escribir.
```

Para `clientes` y `productos`:

```sql
alter table clientes enable row level security;

create policy clientes_select_authenticated on clientes
  for select to authenticated using (true);
create policy clientes_write_authenticated on clientes
  for insert to authenticated with check (true);
create policy clientes_update_authenticated on clientes
  for update to authenticated using (true) with check (true);
-- (mismo patrón para productos)
```

`usuarios` es un caso especial: `SELECT` sigue abierta a `authenticated` (se necesita para
poblar el login por categoría, los selects de vendedor en Movimientos, etc.), pero **nunca**
se expone `password_hash` a nadie porque esa columna se elimina en fase C — a partir de ahí
no hay nada sensible que ocultar en esa tabla.

## 4. Funciones SQL — rework

Las 16 funciones `SECURITY DEFINER` dejan de recibir `p_usuario_id`/`p_vendedor_id`/
`p_admin_id` como parámetro de "quién soy" (hoy es un dato cualquiera que manda el
cliente, sin verificar) y en su lugar resuelven internamente:

```sql
declare
  v_usuario_id uuid;
begin
  select id into v_usuario_id from usuarios where auth_id = auth.uid();
  if v_usuario_id is null then
    raise exception 'PERMISO_DENEGADO';
  end if;
  -- ... resto de la función igual, usando v_usuario_id en vez del parámetro viejo
```

Esto cierra la suplantación de identidad documentada en el audit (sección 8, hallazgo #2):
ya no se puede llamar `anular_venta(p_venta_id, p_usuario_id=<uuid-de-otro>)` porque el
"quién soy" ya no es un argumento — sale del JWT verificado por Supabase.

Funciones afectadas (quitan su parámetro de identidad): `anular_abono`, `anular_movimiento`,
`anular_pago_consigna`, `anular_venta`, `cambiar_estatus_usuario` (queda `p_usuario_id`
objetivo, se quita `p_admin_id`), `actualizar_datos_usuario` (ídem), `crear_producto`,
`registrar_abono`, `registrar_entrada`, `registrar_pago_consigna`, `registrar_traspaso`,
`registrar_venta`. Sin cambio de firma: `generate_folio` (no toma identidad),
`login_usuario`/`crear_usuario`/`cambiar_contrasena`/`admin_resetear_password` (se
**eliminan** en fase C, reemplazadas por Supabase Auth + la Edge Function).

## 5. Frontend

- `app.js`: reemplazar `supabase.rpc('login_usuario', ...)` por
  `supabase.auth.signInWithPassword({ email: correoSintetico(nombre), password })`.
  El flujo visual de 3 pasos (categoría → nombre → contraseña) no cambia nada — solo
  cambia qué se llama al confirmar.
- Sesión: dejar de guardar un objeto plano en `localStorage` a mano — usar la sesión real
  de `supabase.auth` (`onAuthStateChange`/`getSession()`), y derivar `nombre`/`rol`/
  `almacenId` con una consulta a `usuarios where auth_id = auth.uid()` una vez logueado
  (se puede cachear en memoria, no hace falta que sea `localStorage` propio).
- Todas las llamadas `supabase.rpc(...)` que hoy mandan `p_usuario_id`/`p_vendedor_id`/
  `p_admin_id` dejan de mandarlo (ver sección 4) — es una edición mecánica en cada call
  site de `app.js`.
- Pantalla "Mi cuenta" → "Usuarios" (alta/edición/reseteo por admin): sus tres botones dejan
  de llamar `crear_usuario`/`admin_resetear_password`/`cambiar_estatus_usuario` como RPC de
  Postgres y pasan a llamar la Edge Function nueva (`supabase.functions.invoke(...)`).
- Cambio de contraseña propia: sigue en "Mi cuenta", cambia su implementación interna
  (sección 1, punto 4) pero no su UI.

## 6. Edge Function nueva: `admin-usuarios`

Único código servidor del proyecto. Recibe el JWT de quien llama (Supabase se lo pasa
automático), verifica que corresponda a un `usuarios.rol = 'admin'` activo, y si no,
responde 403 sin tocar nada. Tres acciones (`accion` en el body): `crear`, `resetear_password`,
`cambiar_estatus`. Usa el cliente admin de `service_role` (guardado como secreto de
Supabase, nunca en el repo ni en el cliente) solo para las llamadas a
`auth.admin.createUser`/`updateUserById`/`ban`.

## 7. Plan de ejecución por fases (cada una verificable antes de seguir)

| Fase | Qué hace | Punto de rollback |
|---|---|---|
| A | Agrega `usuarios.auth_id`, crea los 5 `auth.users` con contraseña temporal, **sin tocar** `login_usuario` ni el frontend | Total — nada del flujo actual cambia, es 100% aditivo |
| B | Cambia el frontend a `signInWithPassword`; Luis y las 4 personas prueban entrar con su contraseña temporal | Se puede revertir el deploy de `app.js`/`version.js` sin tocar el esquema |
| C | Habilita RLS (sección 3), reescribe las 16 funciones (sección 4), elimina `password_hash`/`login_usuario`/`crear_usuario`/`cambiar_contrasena`/`admin_resetear_password` viejos | Punto sin retorno fácil — solo se ejecuta después de que B esté confirmado funcionando para los 5 en producción |
| D | Despliega la Edge Function `admin-usuarios`, conecta los tres botones de gestión de usuarios | Independiente de C, se puede probar aparte |
| E | Limpieza: actualizar `PROJECT_AUDIT.md`... **no** — ese documento es una foto fija del corte 2026-08-03, no se edita; se referencia desde `TICKETS.md`/`CLAUDE.md` como se hace con el resto de tickets | — |

## 8. Fuera de alcance (explícito)

- Recuperación de contraseña por correo real — seguiría sin haber correos reales de cada
  persona; el correo sintético nunca recibe nada. El reseteo sigue siendo "el admin lo
  hace" (ahora vía la Edge Function en vez de una función SQL).
- 2FA.
- Rate-limiting de intentos de login más allá de lo que Supabase Auth trae por default.
- Tocar las tablas `almacenes`/`stock_almacen` con un modelo de permisos distinto al
  patrón general de la sección 3 — se tratan igual que el resto de tablas "protegidas".

## 9. Antes de ejecutar fase A — pendiente de Luis

- [x] Confirmar el dominio sintético de correo — `@ventasfamilia.internal`.
- [x] Confirmar que está bien resetear la contraseña de los 5 usuarios reales — Luis creó
      las 5 cuentas a mano en el Dashboard de Supabase (Authentication → Users) con
      contraseñas temporales generadas en el chat.
- [x] Confirmar la Edge Function nueva (sección 6).

## 10. Estado de ejecución

- **Fase A — completada (2026-08-04).** Migración `ticket17_add_usuarios_auth_id`
  (columna `usuarios.auth_id`, nullable, FK a `auth.users(id)`, índice único parcial).
  Las 5 cuentas reales se crearon a mano en el Dashboard con `Auto Confirm User` activo
  (verificado en vivo: los 5 `email_confirmed_at` no son null). Migración
  `ticket17_link_usuarios_auth_id` enlazó cada `usuarios.id` con su `auth.users.id`
  correspondiente por coincidencia de correo — verificado en vivo, los 5 quedaron
  enlazados correctamente. `login_usuario()` y el frontend **no se tocaron** — el login
  en vivo sigue siendo el sistema viejo, cero impacto en producción hasta ahora.
- **Fase B — completada (2026-08-04).** `handleLogin()` ahora llama
  `supabase.auth.signInWithPassword({ email: correoSintetico(nombre), password })` en vez
  de `login_usuario()`; si el login de Auth tiene éxito, resuelve el perfil de negocio
  (`id`/`rol`/`activo`/almacén) por `nombre` — sigue sin RLS ni `auth.uid()` todavía, eso
  es Fase C — y si el usuario está `activo = false` cierra la sesión de Auth recién
  creada y lo rechaza (replica el comportamiento que antes vivía en `login_usuario()`).
  `handleLogout()` ahora también llama `supabase.auth.signOut()`. Versión subida a
  `vf-v15`. **Verificado en vivo en el navegador contra producción:** login real como
  Regina con su contraseña temporal → dashboard con datos reales, cero errores de
  consola; Reportes → "Por vendedor" muestra a los 5 usuarios reales, incluido Luis Lima
  con su venta de $1,300 (la ausencia de esta fila era justo el hallazgo del ticket 16);
  logout limpio, vuelve al paso 1 del login. **Pendiente:** que Angie, Alexa, Alexis y el
  propio Luis prueben su contraseña temporal antes de considerar la Fase B cerrada del
  todo — solo se probó con la cuenta de Regina en esta sesión.
- **Fase C — no arrancada.** Habilitar RLS (sección 3) y reescribir las 16 funciones
  `SECURITY DEFINER` para usar `auth.uid()` (sección 4) — el paso que de verdad cierra el
  hallazgo crítico del audit. `login_usuario()` sigue existiendo en la base (sin uso desde
  el frontend después de esta fase B, pero todavía callable — se elimina en Fase C junto
  con `password_hash`).
- **Fase D — no arrancada.** Edge Function `admin-usuarios` (sección 6).
