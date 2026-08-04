# PROJECT_AUDIT.md — Radiografía técnica de "Ventas Familia" (Lima's Sales)

> Auditoría de arquitectura y diseño para un lector externo sin contexto previo del
> proyecto. Describe el **estado actual desplegado**, no la historia de cómo se llegó
> ahí (esa historia vive en [CLAUDE.md](CLAUDE.md) y [TICKETS.md](TICKETS.md)).
>
> **Corte:** 2026-08-03. **Versión de la app en ese momento:** `vf-v13` (fuente:
> [version.js](version.js)).
>
> **Qué se verificó en vivo contra producción** (vía MCP de Supabase, proyecto
> `ventas-familia`, ref `wiewxgkiefsjeonirsid`) **vs. qué se tomó del código/docs**:
> estructura real de las 11 tablas, conteo real de filas, políticas RLS reales, políticas
> de Storage reales, definición SQL completa de 10 de las 17 funciones RPC (las que mueven
> dinero/stock/permisos: `login_usuario`, `registrar_venta`, `registrar_abono`,
> `anular_venta`, `crear_usuario`, `crear_producto`, `registrar_entrada`,
> `registrar_traspaso`, `cambiar_estatus_usuario`, `actualizar_datos_usuario`), lista de
> usuarios reales, advisors de seguridad y performance de Supabase, historial de
> migraciones (63), y estado de git/worktrees. Toda cifra marcada **"(verificado en
> vivo)"** viene de esa fuente. El resto (flujos de UI, SPEC, criterios de aceptación) se
> tomó de `app.js`/`index.html`/`styles.css` y de `SPEC.md`/`TICKETS.md`/`app-map.md`, sin
> cruzarlo contra un entorno de staging (no existe uno — ver sección 10).

---

## 1. Resumen ejecutivo

"Ventas Familia" (marca visible: **Lima's Sales**) es una PWA de punto de venta para un
negocio familiar de reventa al menudeo. Cubre clientes, inventario multi-almacén, ventas
de contado/crédito, abonos, anulaciones, una cuenta de "consigna" interna entre el admin y
cada vendedor, reportes con ganancia neta, y gestión de usuarios — todo en **un solo
archivo `app.js` de 2,595 líneas**, sin framework ni build step, contra un backend de
Supabase donde toda la lógica de negocio vive en 17 funciones SQL `SECURITY DEFINER`.

El sistema funciona y está en uso real (datos de producción, no solo de prueba). La lógica
de negocio en las funciones SQL es sólida — usa locks de fila (`for update`), reparto FIFO
correcto de abonos entre ventas a crédito, snapshots de costo para no corromper reportes
históricos, y valida permisos de rol dentro de cada función.

**El hallazgo que domina esta auditoría:** las 11 tablas de la base de datos tienen **Row
Level Security deshabilitado**, y la aplicación usa la **clave `anon` pública, embebida en
el JavaScript del cliente** (visible por cualquiera con "ver código fuente" del navegador).
Esa combinación anula por completo la disciplina de permisos que sí existe dentro de las
funciones SQL: cualquiera con esa clave puede leer o escribir **directamente** cualquier
fila de cualquier tabla vía la API REST automática de Supabase (PostgREST), sin pasar por
ninguna función — incluyendo leer los hashes de contraseña de los 5 usuarios, editar el
saldo de cualquier cliente, marcar a cualquiera como `admin`, o insertar ventas sin folio
ni validación de stock. Esto fue una decisión explícita y documentada (SPEC sección 13:
"RLS ... se agrega en una fase posterior"), pero a la fecha de este corte **sigue sin
agregarse**, y el negocio ya está operando con dinero y clientes reales.

Segundo hallazgo relevante, menor en severidad pero con impacto funcional confirmado: la
pantalla de Reportes usa una lista de nombres de vendedor **hardcodeada** en el código
(`VENDEDORES_FIJOS`) que ya no coincide con los usuarios reales de producción — dos de los
5 usuarios activos (el admin y una vendedora) quedan **invisibles** en la tabla "Por
vendedor" de Reportes.

---

## 2. Arquitectura general

Sin backend propio: el navegador habla directo con Supabase. No hay servidor intermedio,
no hay build step, no hay framework — HTML/CSS/JS planos servidos como archivos estáticos.

```
┌─────────────────────────────────────────────────────────────────┐
│  Navegador (PWA instalable — iOS/Android/desktop)                │
│                                                                   │
│  index.html + styles.css + app.js (ES module) + service worker   │
│  (sw.js cachea SOLO el shell estático — nunca intercepta         │
│   escrituras ni llamadas a Supabase)                             │
│                                                                   │
│  Librerías cargadas en runtime desde esm.sh (sin bundler):       │
│    @supabase/supabase-js@2 · html2canvas@1 · jspdf@2             │
│                                                                   │
│  Cliente Supabase inicializado con SUPABASE_URL + ANON_KEY       │
│  hardcodeados en texto plano dentro de app.js                    │
└───────────────────────────┬───────────────────────────────────────┘
                            │ HTTPS (clave anon pública)
        ┌───────────────────┼───────────────────────┐
        │                   │                       │
        ▼                   ▼                       ▼
┌───────────────┐  ┌──────────────────┐   ┌─────────────────────┐
│ PostgREST      │  │ RPC               │   │ Storage              │
│ (REST directo  │  │ supabase.rpc(...) │   │ bucket "productos"   │
│ sobre tablas —  │  │ → 17 funciones     │   │ (público, políticas  │
│ RLS OFF en      │  │ SQL, 16 son        │   │ abiertas de          │
│ las 11 tablas)  │  │ SECURITY DEFINER   │   │ select/insert/       │
│                 │  │                    │   │ update/delete)       │
└───────┬─────────┘  └─────────┬──────────┘   └──────────┬───────────┘
        │                      │                          │
        └──────────────────────┴──────────────────────────┘
                               │
                               ▼
              Postgres 17.6 — proyecto Supabase "ventas-familia"
              (ref wiewxgkiefsjeonirsid, us-east-1)
              11 tablas · 17 funciones · 1 bucket de Storage
```

**Despliegue:** `git push` a `main` en GitHub → Vercel redepliega automáticamente (proyecto
`ventas-familia`, plan Hobby, sin paso de build — sirve los archivos tal cual). No hay
entorno de staging ni preview deployments separados de producción; todo push a `main` es
producción.

---

## 3. Tecnologías

| Capa | Tecnología | Versión | Notas |
|---|---|---|---|
| Frontend | HTML/CSS/JS vanilla | — | Sin framework (no React/Vue/etc.), sin TypeScript |
| Módulos JS | ES Modules nativos | — | `<script type="module">`, sin bundler/transpilador |
| Cliente Supabase | `@supabase/supabase-js` | `@2` (mayor únicamente) | Import directo desde CDN `esm.sh`, sin lockfile — la versión menor/patch exacta la resuelve `esm.sh` en cada carga |
| Captura de recibo | `html2canvas` | `@1` | Vía `esm.sh`, mismo riesgo de no-pin |
| PDF | `jsPDF` | `@2` | Vía `esm.sh`, mismo riesgo de no-pin |
| Backend | Supabase (Postgres + PostgREST + Storage) | Postgres `17.6.1.147` | Región `us-east-1`, proyecto `wiewxgkiefsjeonirsid` (verificado en vivo) |
| Lógica de negocio | PL/pgSQL, funciones `SECURITY DEFINER` | — | 17 funciones en `public` (verificado en vivo) |
| Hash de contraseña | `pgcrypto` (`crypt()` + `gen_salt('bf')`) | ext. `1.3` instalada | bcrypt real, no hash débil (verificado en vivo leyendo `crear_usuario`/`login_usuario`) |
| Hosting estático | Vercel | Plan Hobby | Deploy automático en push a `main`, sin build step |
| Gestor de paquetes | Ninguno | — | No hay `package.json`; no hay `npm install` en el flujo |
| PWA | Manifest + Service Worker manual | Cache `vf-v13` | Cachea solo el shell; toda escritura exige red activa |
| Control de versiones | Git + GitHub | — | Rama única `main`, sin PRs — commits directos, algunos vía "worktrees" locales como técnica de aislamiento, luego mergeados a `main` |

---

## 4. Estructura de carpetas

```
Ventas Familia/
├── index.html              # Shell único: login + 4 pestañas + todos los overlays
├── app.js                  # TODA la lógica JS (2,595 líneas, un solo módulo)
├── styles.css               # Paleta "Lima's Sales" (teal/navy), ~960 líneas
├── sw.js                    # Service worker — cachea shell, lee versión de version.js
├── version.js               # Fuente única de versión (self.CACHE_VERSION = 'vf-v13')
├── manifest.json             # PWA manifest
├── icon.svg                  # Logo "LS"
├── SPEC.md                   # Reglas de negocio — documento de planeación original
├── TICKETS.md                # 15 tickets, todos ✅, con notas de qué se probó
├── CLAUDE.md                  # Convenciones del proyecto para trabajar con Claude Code
├── app-map.md                 # Mapa de pantallas — **NO está en git** (.gitignore),
│                               #   y a este corte está DESACTUALIZADO (dice que Reportes
│                               #   está "pendiente ticket 11"; ticket 11 se cerró hace días)
├── docs/superpowers/
│   ├── plans/                 # 7 planes de implementación (uno por ticket 08–15)
│   └── specs/                 # 7 design docs ("por qué" de anulaciones, multi-almacén,
│                               #   consigna, ganancia por vendedor, gestión de usuarios,
│                               #   login en 2 pasos, recibos PDF/WhatsApp)
├── .worktrees/                 # Carpeta de un worktree de git ya mergeado (ticket 09),
│                               #   no limpiada — gitignored, no aparece en `git worktree list`
├── .claude/worktrees/           # Ídem para ticket 15 — misma situación
├── .superpowers/sdd/            # Metadatos de sesiones de diseño (gitignored)
└── Biblioteca-Libros/, *.md      # Material de otra iniciativa (biblioteca de marketing/
                                  #   ventas para la familia) — no forma parte de la PWA,
                                  #   convive en el mismo directorio de trabajo
```

No existe `package.json`, `vite.config.js` ni `App.jsx` — el proyecto **no usa React ni
ningún bundler**; es intencional (ver CLAUDE.md: "Sin build step").

---

## 5. Base de datos

**Motor:** Postgres 17.6.1.147 gestionado por Supabase, proyecto `ventas-familia`
(`wiewxgkiefsjeonirsid`, `us-east-1`), creado 2026-07-26 (verificado en vivo).

**Principio de RLS: deshabilitado en las 11 tablas de `public`, verificado en vivo y
confirmado por el advisor de seguridad de Supabase como hallazgo `CRITICAL`.** Ver sección
8 para el análisis de impacto — no es un detalle menor, es el hallazgo central de este
documento.

### Volumetría real (verificado en vivo, `COUNT(*)` directo, 2026-08-03)

| Tabla | Filas | Notas |
|---|---:|---|
| `usuarios` | 5 | 1 admin + 4 vendedores, todos `activo = true` |
| `clientes` | 3 | |
| `productos` | 5 | |
| `ventas` | 7 | |
| `venta_items` | 7 | |
| `abonos` | 0 | Ningún abono de cliente registrado aún — todo lo cobrado hasta ahora fue enganche/contado |
| `venta_pagos` | 5 | Registro de cobros reales (para ganancia neta), todos originados en pago inmediato, no en abono |
| `almacenes` | 6 | 1 "Central" + 1 por usuario (5) |
| `stock_almacen` | 11 | Combinaciones producto×almacén con stock asignado (disperso, no 5×6=30) |
| `movimientos_almacen` | 40 | Incluye movimientos de prueba ya anulados (nunca se borran, ver sección 10) |
| `pagos_consigna` | 2 | Incluye 1 pago de prueba ya anulado (folio `REC-D4F3637B`, documentado en TICKETS ticket 14) |

Es una base de datos joven (~1 semana de operación al corte) con datos reales mezclados
con remanentes de pruebas ya anuladas — consistente con la política de "nunca borrar".

### Usuarios reales (verificado en vivo) — y por qué esto importa

| Nombre | Rol | Activo |
|---|---|---|
| Luis Lima | admin | sí |
| Alexa | vendedor | sí |
| Alexis | vendedor | sí |
| Angie | vendedor | sí |
| Regina | vendedor | sí |

**Esto ya no coincide con la documentación estática del proyecto.** `SPEC.md` y el
`CLAUDE.md` de este proyecto todavía describen "Papá / Angie / Alexa / Alexis" como los 4
usuarios fijos — pero desde el ticket 12 (gestión de usuarios dinámica) esa lista dejó de
ser fija, "Papá" se dio de alta como "Luis Lima", y se agregó una quinta vendedora
("Regina") que no aparece mencionada en ningún documento del repo. El propio `CLAUDE.md` ya
reconoce esta desactualización al final de la sección de progreso, pero **el código todavía
depende de la lista vieja** — ver hallazgo en sección 10.

### Catálogos globales

No hay tablas de catálogo cerrado (a propósito — SPEC sección 15: categoría de producto es
texto libre, no taxonomía fija). Los únicos valores controlados por `CHECK` constraint son
`usuarios.rol` (`admin`/`vendedor`) y `ventas.tipo` (`contado`/`credito`).

### Tablas por módulo (FKs relevantes)

| Tabla | Módulo | FKs relevantes |
|---|---|---|
| `usuarios` | Auth / gestión de usuarios | — (referenciada por casi todo) |
| `clientes` | Clientes | — |
| `productos` | Inventario | — |
| `almacenes` | Multi-almacén | `usuario_id → usuarios` (null = almacén "Central") |
| `stock_almacen` | Multi-almacén | PK compuesta `(producto_id, almacen_id)`, ambas FK |
| `movimientos_almacen` | Multi-almacén | `producto_id`, `almacen_origen_id`/`almacen_destino_id → almacenes`, `usuario_id`/`anulado_por → usuarios` |
| `ventas` | Ventas | `cliente_id → clientes` (nullable), `vendedor_id`/`anulado_por → usuarios` |
| `venta_items` | Ventas | `venta_id → ventas`, `producto_id → productos` |
| `venta_pagos` | Ganancia por vendedor | `venta_id → ventas`, `abono_id → abonos` (nullable — null cuando el pago es el enganche/contado inmediato) |
| `abonos` | Abonos | `cliente_id → clientes`, `vendedor_id`/`anulado_por → usuarios` |
| `pagos_consigna` | Consigna | `vendedor_id`/`usuario_id`/`anulado_por → usuarios` |

### Storage

Bucket `productos` (fotos de inventario), marcado "público" en Supabase. Tiene 4 políticas
RLS **abiertas** sobre `storage.objects` (verificado en vivo):

| Política | Comando | A quién aplica | Condición |
|---|---|---|---|
| `productos_bucket_select` | SELECT | `anon`, `authenticated` | `bucket_id = 'productos'` |
| `productos_bucket_insert` | INSERT | `anon`, `authenticated` | `bucket_id = 'productos'` |
| `productos_bucket_update` | UPDATE | `anon`, `authenticated` | `bucket_id = 'productos'` |
| `productos_bucket_delete` | DELETE | `anon`, `authenticated` | `bucket_id = 'productos'` |

Es decir: cualquiera con la clave `anon` puede subir, sobrescribir o **borrar** cualquier
archivo del bucket, no solo el suyo. El advisor de seguridad además marca que la política
de `SELECT` permite *listar* el contenido completo del bucket (`public_bucket_allows_listing`,
severidad `WARN`), algo que un bucket público normalmente no necesita para servir imágenes
por URL.

### Funciones RPC (17 en `public`, verificado en vivo)

| Función | Seguridad | Qué hace |
|---|---|---|
| `login_usuario` | DEFINER | Verifica nombre+contraseña con `crypt()`, filtra `activo=true`, no distingue "no existe" de "contraseña mal" (buena práctica anti-enumeración — pero ver sección 8 sobre por qué esto no importa) |
| `generate_folio` | **INVOKER** (única no-DEFINER) | Genera `REC-XXXXXXXX` único, reintenta hasta no chocar |
| `registrar_venta` | DEFINER | Atómica: valida stock del almacén del vendedor con lock, calcula costo snapshot, inserta venta+items, descuenta stock, registra pago inmediato en `venta_pagos` |
| `registrar_abono` | DEFINER | Atómica: bloquea saldo del cliente, reparte el monto **FIFO** entre las ventas a crédito abiertas de ese cliente (la más antigua primero), calcula utilidad realizada proporcional por venta |
| `anular_venta` | DEFINER | Repone stock al almacén del vendedor de la venta (no a Central), resta solo lo que quedaba pendiente de esa venta específica del saldo del cliente, nunca dejando negativo |
| `anular_abono` | DEFINER | Revierte el reparto FIFO de `venta_pagos`, regresa el monto al saldo del cliente |
| `crear_usuario` | DEFINER | Alta con hash bcrypt (`crypt(..., gen_salt('bf'))`), crea su almacén propio en la misma transacción |
| `cambiar_contrasena` | DEFINER | Autoservicio, exige la contraseña actual |
| `admin_resetear_password` | DEFINER | Exige rol admin (verificado dentro de la función, no solo en UI) |
| `cambiar_estatus_usuario` | DEFINER | Activa/desactiva; bloquea desactivar al último admin activo |
| `actualizar_datos_usuario` | DEFINER | Cambia nombre/rol; mismo bloqueo de "último admin" |
| `crear_producto` | DEFINER | Exige rol admin; alta con stock inicial atómico a Central |
| `registrar_entrada` | DEFINER | Exige rol admin; entrada de stock siempre a Central, guarda `costo_snapshot` |
| `registrar_traspaso` | DEFINER | Exige rol admin; mueve stock entre cualquier par de almacenes con lock, y si origen/destino es el almacén de un vendedor, mueve `deuda_consigna` simétricamente |
| `anular_movimiento` | DEFINER | Revierte stock y deuda de consigna; bloquea si ya no hay stock suficiente para revertir |
| `registrar_pago_consigna` | DEFINER | Rechaza pagos mayores a la deuda actual (`MONTO_EXCEDE_DEUDA`) |
| `anular_pago_consigna` | DEFINER | Revierte la deuda |

**Todas las funciones de permiso elevado (crear/anular/admin) sí validan el rol del
usuario dentro del cuerpo SQL** (leyendo `usuarios.rol`/`usuarios.activo` con el
`p_usuario_id` que manda el cliente) — no confían únicamente en la UI. Esto es correcto en
sí mismo, pero ver sección 8: con RLS apagado, un atacante no necesita llamar a estas
funciones en absoluto.

---

## 6. Módulos funcionales

| # | Módulo | Ruta/entrada en la UI | Roles con acceso | Qué hace |
|---|---|---|---|---|
| 1 | Login | `#view-login` | Todos (previo a auth) | 3 pasos: categoría (admin/vendedor) → nombre → contraseña; salto directo a contraseña si la categoría tiene un solo usuario |
| 2 | Inicio / Dashboard | pestaña `Inicio` | Todos, mismo contenido | Ventas/abonos del día (todo el negocio) + clientes con saldo pendiente + accesos rápidos |
| 3 | Inventario | pestaña `Inventario` | Todos ven; solo admin da de alta (+) | Grid de productos, stock agregado, filtro por categoría; detalle muestra stock por almacén |
| 4 | Clientes | pestaña `Clientes` | Todos, alta/edición sin restricción de rol | Lista + alta/edición, nombre único |
| 5 | Reportes | pestaña `Reportes` | Todos, mismo contenido | Selector de mes, total vendido/ganancia del periodo, saldo pendiente del negocio, deuda de consigna total, tabla por vendedor, detalle artículo por artículo |
| 6 | Nueva venta | acceso rápido en Inicio | Todos | Carrito desde el stock del almacén propio del vendedor logueado, contado/crédito, precio editable por línea, recibo con PDF/WhatsApp |
| 7 | Nuevo abono | acceso rápido en Inicio | Todos | Abono contra cualquier cliente con saldo, validado servidor-side contra sobrepago |
| 8 | Historial / Anulaciones | acceso rápido en Inicio | Todos ven; anular: dueño del registro o admin | Lista combinada ventas+abonos, anulación con reversión atómica |
| 9 | Movimientos | acceso rápido en Inicio | Todos ven; alta/anulación solo admin | Traspasos/entradas de stock entre almacenes + resumen de deuda de consigna + pagos de consigna |
| 10 | Mi cuenta | ícono 👤 en topbar | Todos ven su propia sección; "Usuarios" solo admin | Cambio de contraseña propia; admin además da de alta/edita/desactiva usuarios |

---

## 7. Flujo principal de punta a punta — venta a crédito con abono posterior

Este es el flujo más maduro del sistema (tickets 05, 06, 09, 11 construidos sobre él) y el
que mejor ilustra la arquitectura real.

1. **Login:** el vendedor abre la app → elige categoría "Vendedores" → elige su nombre →
   contraseña. El cliente llama `supabase.rpc('login_usuario', {p_nombre, p_password})`.
   La función compara `crypt(p_password, password_hash) = password_hash` (bcrypt real) y
   solo devuelve fila si además `activo = true`. Si falla, no distingue "no existe" de
   "contraseña incorrecta" — buen detalle anti-enumeración a nivel de esta función
   puntual (aunque irrelevante dado el hallazgo de la sección 8).
2. La sesión se guarda en `localStorage` (`vf_user`), incluyendo el `almacenId` propio del
   vendedor (resuelto con una segunda consulta a `almacenes`).
3. **Nueva venta → Crédito:** el vendedor selecciona productos; la lista de "disponibles"
   viene filtrada por `stock_almacen.almacen_id = <almacén del vendedor logueado>` — es
   decir, un vendedor solo puede vender lo que físicamente tiene en su propio almacén,
   aunque Central tenga de sobra. Selecciona un cliente (obligatorio en crédito), captura
   un enganche opcional, y confirma.
4. El cliente llama `registrar_venta(p_tipo='credito', p_cliente_id, p_vendedor_id,
   p_enganche, p_items)`. Dentro de una sola transacción PL/pgSQL:
   - Resuelve el almacén del vendedor y bloquea (`for update`) el renglón de
     `stock_almacen` de cada producto para evitar carreras con otra venta simultánea.
   - Si el stock es insuficiente, aborta con `STOCK_INSUFICIENTE` (el cliente lo traduce a
     un mensaje claro).
   - Calcula `costo_total` (snapshot del costo actual del producto — no se recalcula
     después aunque el costo del catálogo cambie).
   - Inserta la venta con `saldo_pendiente_venta = total - enganche`.
   - Descuenta stock del almacén del vendedor (no de Central).
   - Si hubo enganche > 0, inserta una fila en `venta_pagos` con la utilidad ya realizada
     proporcional al enganche.
   - Suma `(total - enganche)` al `saldo_pendiente` global del cliente.
5. El folio (`REC-XXXXXXXX`) vuelve al cliente, que arma el recibo en pantalla (folio,
   fecha, vendedor, cliente, líneas, total, enganche, saldo resultante) y refresca
   Inventario/Clientes/Dashboard.
6. **Días después, otro vendedor cualquiera cobra un abono** de ese cliente (no tiene que
   ser el mismo que hizo la venta — "todos ven todo"). Llama `registrar_abono`, que:
   - Bloquea el saldo del cliente y rechaza si `monto > saldo_pendiente`
     (`MONTO_MAYOR_A_SALDO`) — la validación autoritativa vive en SQL, no solo en la UI.
   - Recorre las ventas a crédito abiertas de ese cliente **ordenadas por fecha ascendente**
     (FIFO: la más vieja se cobra primero) y aplica el monto repartiéndolo entre ellas,
     insertando una fila en `venta_pagos` por cada venta tocada con su utilidad
     proporcional.
   - Descuenta el saldo global del cliente.
7. **Si esa venta se anula después** (por error, por ejemplo), `anular_venta` repone el
   stock al almacén del vendedor original de la venta (no a Central — puede que ya no
   tenga sentido reponerlo ahí, pero así está implementado) y resta del saldo del cliente
   únicamente lo que le quedaba pendiente a **esa** venta en particular — los abonos ya
   aplicados (`venta_pagos`) nunca se tocan ni se pierde la ganancia ya realizada sobre
   ellos.
8. **Reportes** agrega todo esto por mes: suma `venta_pagos.utilidad_realizada` del periodo
   para la ganancia neta, cruza `ventas`/`abonos` por vendedor — **con la salvedad del
   hallazgo de la sección 10** (la lista de vendedores para esa tabla está hardcodeada y ya
   no incluye a todos los usuarios reales).

---

## 8. Roles y seguridad

### Roles (verificado en vivo)

| Rol | Usuarios activos | Puede hacer |
|---|---:|---|
| `admin` | 1 (Luis Lima) | Todo lo de vendedor + anular cualquier registro + dar de alta productos/usuarios + gestionar movimientos de almacén/consigna |
| `vendedor` | 4 (Alexa, Alexis, Angie, Regina) | Vender, abonar, anular solo lo propio, ver todo el negocio (dashboard, reportes, historial completos) |

### Modelo de autenticación

No usa Supabase Auth. Es un login propio: nombre (de una lista dinámica poblada desde
`usuarios where activo=true`) + contraseña, verificados por `login_usuario()`
`SECURITY DEFINER` con hash bcrypt vía `pgcrypto`. La sesión es un objeto plano en
`localStorage`, sin JWT de usuario, sin expiración, sin refresh — persiste hasta logout
manual o hasta que se borre el storage del navegador.

### RLS — el hallazgo central

**Las 11 tablas de `public` tienen RLS deshabilitado** (verificado en vivo; confirmado por
Supabase Advisors como `rls_disabled_in_public`, nivel `ERROR`, en las 11 tablas). Esto fue
una decisión explícita documentada desde el ticket 01 ("RLS queda deshabilitado a
propósito ... fuera de alcance v1") — pero el proyecto ya tiene datos reales y clientes
reales, y **la clave `anon` está hardcodeada en texto plano en `app.js`**, visible a
cualquiera que abra las herramientas de desarrollador del navegador en la app pública en
Vercel.

**Impacto concreto (no hipotético — se verificó que las políticas de PostgREST lo permiten):**
con esa clave `anon`, cualquiera puede hacer peticiones REST directas a
`https://wiewxgkiefsjeonirsid.supabase.co/rest/v1/<tabla>` que **evitan por completo** las
17 funciones `SECURITY DEFINER` y su lógica de negocio/permisos:

- `GET /usuarios?select=*` — descarga los 5 `password_hash` (bcrypt, pero igual queda
  expuesto para intentar crackeo offline) y confirma nombres/roles sin pasar por
  `login_usuario`.
- `PATCH /usuarios?id=eq.<uuid>` — puede poner `rol='admin'` a cualquier usuario, o
  `activo=true` sin el chequeo de "último admin" que sí protege `cambiar_estatus_usuario`.
- `PATCH /clientes?id=eq.<uuid>` — puede editar `saldo_pendiente` directo, sin folio, sin
  rastro de venta/abono asociado.
- `POST /ventas`, `POST /stock_almacen`, `PATCH /productos` — inserta o edita registros sin
  los locks, sin el descuento de stock correlacionado, sin `generate_folio()`, rompiendo la
  trazabilidad ("nunca se borra, siempre se anula") porque **tampoco hay nada que impida un
  `DELETE` real** vía REST.
- Storage: las 4 políticas abiertas sobre `storage.objects` (sección 5) permiten subir,
  sobrescribir o borrar cualquier archivo del bucket `productos`, no solo fotos propias.

En otras palabras: **todo el diseño cuidadoso de permisos dentro de las funciones SQL
(secciones 5 y 7) es cosmético mientras RLS siga apagado**, porque PostgREST expone las
tablas crudas en paralelo a esas funciones, con la misma clave.

Adicionalmente, los Advisors marcan 15 hallazgos `WARN` de tipo
`anon_security_definer_function_executable` / `authenticated_security_definer_function_executable`
— es decir, **todas** las 15 funciones `SECURITY DEFINER` (además de `login_usuario`) son
ejecutables sin ningún tipo de autenticación de Supabase, lo cual es coherente con el
diseño ("login propio, no Supabase Auth"), pero significa que no hay ninguna capa de
autenticación de plataforma por debajo del `p_usuario_id` que manda el cliente — ese
parámetro es simplemente un dato más en el payload JSON, no un token verificado. Cualquiera
con la clave `anon` puede llamar `anular_venta(p_venta_id, p_usuario_id=<uuid-de-Luis>)`
haciéndose pasar por el admin sin haber iniciado sesión como él.

### Superficie de ataque conocida (resumen)

1. **Crítico:** lectura/escritura completa de las 11 tablas sin pasar por RLS ni por las
   funciones de negocio (clave `anon` pública + RLS off).
2. **Crítico:** cualquier función `SECURITY DEFINER` puede invocarse suplantando a
   cualquier `p_usuario_id` (no hay verificación de que quien llama realmente inició sesión
   como ese usuario — el "login" es solo una pantalla de UI, no un mecanismo de sesión
   verificable server-side).
3. **Alto:** Storage del bucket `productos` permite subir/sobrescribir/borrar cualquier
   archivo, y listar el bucket completo.
4. **Bajo/aceptado:** sin recuperación de contraseña, sin 2FA, sin rate-limiting visible en
   `login_usuario` (permite fuerza bruta ilimitada de contraseñas — mitigado en la práctica
   por ser 5 usuarios con contraseñas propias, no la genérica `2026` original).

### Hallazgos de los advisors (resumen cuantitativo, verificado en vivo)

- **Seguridad:** 11 `ERROR` (RLS deshabilitado, uno por tabla) + 16 `WARN` (1 de Storage +
  15 de funciones `SECURITY DEFINER` ejecutables sin auth).
- **Performance:** 12 `INFO` de foreign keys sin índice de cobertura (`abonos`,
  `movimientos_almacen`, `pagos_consigna`, `stock_almacen`, `venta_items`, `ventas`) + 1
  `INFO` de índice sin uso (`pagos_consigna_vendedor_id_idx`). Con los volúmenes actuales
  (decenas de filas) esto no tiene impacto real todavía, pero son los índices que faltarán
  primero cuando el historial crezca.

---

## 9. Funcionalidades pendientes

Explícitamente fuera de alcance en `SPEC.md` sección 13, todavía sin implementar a este
corte:

- Row Level Security real con políticas por rol (ver sección 8 — ya no es "fuera de
  alcance opcional", es el riesgo más grande del sistema).
- Recargos/intereses por atraso en crédito (decisión de negocio: nunca los va a haber).
- Saldo a favor por sobrepago.
- Plazos o fechas de vencimiento en crédito.
- Código de barras/SKU, múltiples fotos por producto.
- Cola offline / sincronización sin conexión (decisión de negocio: no es prioridad).
- Notificaciones push.
- Exportar reportes a Excel/CSV.
- Gráficas en Reportes (solo tablas/texto).
- Recuperación de contraseña propia (si un vendedor la olvida, solo el admin puede
  resetearla vía `admin_resetear_password`).
- Filtro por responsable en pendientes/movimientos, vista de historial exclusivamente de
  cerrados (mencionados como ideas futuras, sin ticket abierto).

---

## 10. Deuda técnica

1. **RLS deshabilitado en producción con datos reales, clave `anon` pública en el
   cliente.** Ya detallado en la sección 8 — es el punto más urgente de este documento.
   Importa porque el negocio ya opera con clientes y saldos reales; cualquier persona con
   conocimientos básicos de DevTools y 5 minutos puede leer o alterar cualquier dato sin
   dejar rastro reconocible por la app (los cambios vía REST directo no pasan por
   `anulado`/`anulado_por`, así que ni siquiera quedaría la trazabilidad que el diseño de
   anulaciones sí garantiza cuando se usa por la app normal).

2. **`VENDEDORES_FIJOS` hardcodeado en `app.js` (línea 1568) ya no coincide con los
   usuarios reales.** El arreglo `['Papá', 'Angie', 'Alexa', 'Alexis']` alimenta la tabla
   "Por vendedor" de Reportes filtrando ventas/abonos/ganancia por coincidencia exacta de
   nombre. En producción el admin se llama "Luis Lima" (no "Papá") y existe una quinta
   vendedora activa, "Regina", que no está en la lista. Resultado verificado por lectura
   directa del código y cruce contra la tabla `usuarios` real: **las ventas, abonos y
   ganancia de Luis Lima y de Regina no aparecen en esa tabla**, aunque sí se cuentan
   correctamente en los totales agregados de arriba (vendido del periodo, ganancia total,
   saldo pendiente) porque esos sí se calculan sin filtrar por nombre. Importa porque es
   justo el reporte que un gerente usaría para evaluar desempeño por vendedor, y hoy
   subestima silenciosamente a 2 de 5 personas sin ningún error visible en pantalla.

3. **`app-map.md` está desactualizado y fuera de git (`.gitignore`).** Dice que Reportes
   está "pendiente (ticket 11)" cuando ese ticket se cerró varios días antes de este corte,
   y no menciona en absoluto los módulos de Movimientos/Consigna/Usuarios. Al estar
   gitignored, ningún diff de PR ni revisión de commit fuerza a mantenerlo sincronizado —
   es responsabilidad puramente manual, y ya se rompió.

4. **Documentación de negocio (`SPEC.md`, `CLAUDE.md` de este proyecto) describe 4
   usuarios fijos que ya no son fijos desde el ticket 12.** El propio `CLAUDE.md` lo
   reconoce al final de su sección de progreso, pero el texto principal (tabla "Usuarios y
   roles") sigue mostrando la lista vieja como si fuera la fuente de verdad — un lector
   nuevo del documento se lleva información incorrecta antes de llegar a la nota al pie que
   la corrige.

5. **Dependencias de frontend sin pin de versión exacta.** `@supabase/supabase-js@2`,
   `html2canvas@1`, `jspdf@2` se resuelven vía `esm.sh` a la última versión menor/patch
   disponible de esa major en cada carga de página — no hay lockfile porque no hay gestor
   de paquetes. Un cambio de comportamiento en una versión menor de `supabase-js` (o una
   caída de `esm.sh`) se propaga a producción sin ningún control de versión ni aviso.

6. **Migraciones de prueba mezcladas con migraciones de esquema en el historial de
   producción.** De las 63 migraciones aplicadas (verificado en vivo), varias llevan
   nombres como `test_probe_noop`, `step2_create_test_vendedor`,
   `step4_deactivate_papa_with_second_admin`, `task4_setup_test_user` — es decir, la
   verificación de las funciones SQL (crear usuarios de prueba, desactivarlos, revertir)
   se hizo directamente contra la base de datos de producción, migración por migración, en
   ausencia de un proyecto Supabase de staging o de branching. El propio TICKETS.md
   documenta que cada vez se limpió el dato de prueba al cerrar el ticket, pero el patrón
   en sí (no hay ambiente aislado para probar cambios de esquema) es un riesgo estructural,
   no solo histórico — el próximo cambio de esquema se va a probar la misma forma.

7. **Sin pruebas automatizadas ni CI.** Toda la verificación documentada en TICKETS.md es
   manual: navegador real + consultas SQL directas ejecutadas a mano contra producción. No
   hay un solo archivo de test en el repo. Cualquier regresión depende de que alguien la
   note manualmente antes o después de un deploy (que además es automático en cada push a
   `main`, sin gate de por medio).

8. **Carpetas de worktree de git sin limpiar.** `.worktrees/ticket-09-recibos-pdf-whatsapp`
   y `.claude/worktrees/ticket-15-login-2pasos` siguen en disco (la primera gitignored, la
   segunda no verificada); `git worktree list` ya no las reconoce como worktrees activos
   (las ramas correspondientes ya se mergearon a `main`). Es limpieza pendiente de bajo
   riesgo, pero acumula.

9. **12 foreign keys sin índice de cobertura + 1 índice sin uso** (sección 8, detalle de
   performance advisors). Bajo impacto con el volumen actual; alto impacto potencial en
   `movimientos_almacen` y `ventas`/`abonos` si el historial crece órdenes de magnitud sin
   revisar esto.

10. **Recibo de "Nueva venta" no refleja precios editados de forma completamente
    consistente con el costo mostrado.** El carrito permite editar el precio de venta por
    línea (ticket 11), y el costo se mantiene oculto por default con un botón de "ojo" —
    esto es una decisión de diseño intencional (no mostrar costo al cliente), pero significa
    que el % de utilidad real de una venta con precio editado solo es visible después, en
    Reportes, nunca en el momento de la venta — un vendedor puede vender por debajo del
    costo sin ninguna advertencia en pantalla.

---

## 11. Decisiones de diseño importantes

- **Sin framework, sin build step, deploy = archivos estáticos.** Decisión explícita
  (CLAUDE.md) para mantener el proyecto simple dado el tamaño del equipo (4-5 personas,
  1 desarrollador ad-hoc). Funciona bien para el tamaño actual de `app.js`, pero ya está en
  el límite de lo razonable para un solo archivo de 2,595 líneas sin ningún tipo de
  modularización — cada nuevo módulo (Movimientos, Consigna, Usuarios) se agregó como más
  funciones al mismo archivo.

- **Login propio en vez de Supabase Auth.** Decisión explícita para no requerir un correo
  por persona en un negocio de 4-5 usuarios fijos (SPEC sección 1). Es razonable para el
  caso de uso, pero como se documenta en la sección 8, esa decisión combinada con RLS
  apagado deja la app sin ninguna capa de autenticación verificable del lado del servidor —
  el costo de la simplicidad se pagó en superficie de ataque, y el propio SPEC lo anticipó
  ("RLS ... se agrega en una fase posterior") sin que esa fase posterior haya llegado.

- **"Todos ven todo".** Filosofía explícita de negocio familiar de confianza (SPEC sección
  1) — no hay pantallas ni reportes ocultos entre roles, la única diferencia real es quién
  puede anular registros ajenos. Esto simplifica mucho la UI (no hay lógica de visibilidad
  condicional más allá de un puñado de `if (session.rol === 'admin')`), a costa de que
  cualquier vendedor puede ver el negocio completo, incluyendo deuda de consigna de otros
  vendedores.

- **Nunca se borra, siempre se anula.** Patrón reutilizado de otros proyectos del mismo
  autor (mencionado en SPEC). Se respeta consistentemente en las 4 tablas transaccionales
  (`ventas`, `abonos`, `movimientos_almacen`, `pagos_consigna`) vía columnas
  `anulado`/`anulado_por`/`anulado_en`. El precio de esta garantía es que solo se sostiene
  mientras todas las escrituras pasen por las funciones RPC — con RLS apagado (sección 8),
  un `DELETE` directo vía REST la rompe sin dejar rastro.

- **Saldo global por cliente, no por venta.** Una venta a crédito no es una cuenta aislada
  — su saldo pendiente se suma a una sola cuenta por cliente (SPEC sección 2). Esto obligó
  a construir el reparto FIFO de abonos entre ventas (ticket 11,
  `docs/superpowers/specs/2026-07-30-ganancia-por-vendedor-design.md`) para poder calcular
  ganancia realizada por venta individual sin perder la simplicidad del saldo único de cara
  al usuario.

- **Precio de venta editable por línea, costo oculto por default.** Se agregó en el
  ticket 11 sobre el diseño original (que tenía precio fijo del catálogo) para dar
  flexibilidad de negociación en el mostrador, sin exponer el costo al cliente que ve la
  pantalla. Ver hallazgo de deuda técnica #10 sobre el riesgo de vender bajo costo sin
  aviso.

- **Multi-almacén con un almacén por vendedor + "Central".** Modela que cada vendedor trae
  físicamente cierta mercancía consigo (ticket 13) — un vendedor solo puede vender lo que
  tiene en su propio almacén, no el stock total del negocio. Esto llevó naturalmente a la
  necesidad del ticket 14 (deuda de consigna): si el producto se le entrega a un vendedor,
  alguien tiene que rastrear que ese vendedor debe el costo de esa mercancía hasta que la
  venda, la devuelva o la pague.

---

## 12. Limitaciones conocidas

- Operación 100% online — sin conexión no se puede vender, abonar, ni dar de alta clientes
  o productos (decisión de negocio explícita, no un bug).
- Sin recuperación de contraseña por autoservicio — depende del admin.
- El costo histórico de ventas anteriores a la migración de "ganancia por vendedor" (ticket
  11) quedó en $0 / 100% utilidad porque no hay costo que reconstruir retroactivamente
  (documentado y aceptado en TICKETS.md).
- El % de utilidad y la atribución de ganancia por vendedor dependen de que `productos.costo`
  esté siempre capturado correctamente — no hay ninguna alerta si un producto se da de alta
  con un costo incorrecto; simplemente distorsiona Reportes en silencio.
- Reportes "Por vendedor" con el problema de hardcoding descrito en la sección 10 — no
  refleja a todos los vendedores reales a este corte.
- Sin pruebas automatizadas — toda garantía de correctness depende de verificación manual
  puntual al cerrar cada ticket, no de una suite que se re-ejecute en cada cambio futuro.

---

## 13. Roadmap actual

`TICKETS.md` no tiene ningún ticket abierto — los 15 tickets originales (01 a 15) están
cerrados. La propia nota de cierre del proyecto dice explícitamente:

> **Pendiente:** ninguno de los tickets 01-15. Próximos pasos por definir con Luis.

No hay un roadmap declarado más allá de esa nota. Dado lo encontrado en esta auditoría, los
candidatos más obvios para una siguiente conversación con Luis, en orden de urgencia real
(no de esfuerzo), serían: habilitar RLS con políticas mínimas antes de que el volumen de
datos reales crezca más; corregir `VENDEDORES_FIJOS` para que lea usuarios reales en vez de
una lista fija; y decidir si vale la pena introducir un ambiente de staging antes del
próximo cambio de esquema.
