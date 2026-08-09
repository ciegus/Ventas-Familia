# SPEC — PWA Negocio Familiar de Reventa ("Lima's Sales", antes "Ventas Familia")

> Documento de planeación. Ningún archivo de código (.js, .jsx, .ts, .sql) existe todavía —
> este SPEC y el TICKETS.md que sigue son los únicos entregables hasta que se aprueben
> explícitamente ambos.

## 1. Descripción del negocio y usuarios

Negocio familiar de reventa al **menudeo/minorista**. El catálogo es **variado y sin
categoría fija** — se revende lo que se vaya encontrando/consiguiendo, no un giro
específico (ropa, electrónicos, etc. mezclados).

**4 usuarios, 2 roles:**

| Usuario | Rol | Puede hacer |
|---|---|---|
| Papá | `admin` | Todo lo que un vendedor + anular CUALQUIER registro (no solo el suyo) |
| Angie | `vendedor` | Vender, abonar, anular sus propios registros, ver todo el negocio |
| Alexa | `vendedor` | Igual que Angie |
| Alexis | `vendedor` | Igual que Angie |

**Filosofía de datos: "todos ven todo".** Es un negocio familiar de confianza, no una
operación con vendedores que compiten entre sí — no hay pantallas ni reportes ocultos
entre roles. La única diferencia real de permisos entre `admin` y `vendedor` es la
capacidad de anular registros ajenos.

**Uso:** principalmente en celular (iOS y Android), como PWA instalable. Marca:
**"Lima's Sales"** — logo tipo monograma "LS" en degradado teal/cyan con texto en navy
oscuro. El nombre y logo sí son visibles en la app (login, header, ícono de instalación)
y en el recibo — decisión que reemplaza la idea inicial de app "anónima" (ver sección 15).

**Login:** simplificado, sin Supabase Auth real ni correos — mismo patrón que
"Gestión de Mantenimiento" (elegir nombre de una lista fija de 4 personas + contraseña
propia, verificada por una función `SECURITY DEFINER` con hash `bcrypt`/`pgcrypto`, nunca
expuesta por RLS pública). Se decidió así explícitamente sobre Supabase Auth real, para
no necesitar un correo por persona en un negocio de 4 usuarios fijos.

## 2. Módulo: Clientes

| Campo | Regla |
|---|---|
| Nombre | Obligatorio. **Único** — el sistema bloquea el registro de un nombre exactamente duplicado (si hay dos personas con el mismo nombre real, se pide diferenciarlos con un apodo o inicial al capturarlos, ej. "Juan Pérez (papelería)"). |
| Teléfono | Opcional siempre, incluso para clientes a crédito. |
| Saldo pendiente | **Global por cliente** — no por venta individual. Todas las ventas a crédito de un mismo cliente se acumulan en una sola cuenta/saldo, sin importar cuántas ventas distintas las originaron. |

**Sin más campos en v1** (sin dirección, sin correo, sin nota libre) — se agregan después
si hace falta.

## 3. Módulo: Inventario (productos)

| Campo | Regla |
|---|---|
| Nombre | Obligatorio. |
| Precio | **Obligatorio** — no se puede guardar un producto sin precio. |
| Foto | **Obligatoria** — no se puede guardar un producto sin foto (una sola foto por producto, no galería). |
| Stock | Cantidad disponible, obligatorio, entero ≥ 0. |
| Categoría | **Texto libre, opcional** (no bloquea guardar el producto) — no es un catálogo fijo de categorías, es una etiqueta libre para poder agrupar/filtrar en Inventario, acorde a que el negocio vende "lo que se encuentre" sin un giro fijo (ver sección 15). |

**Sin código de barras/SKU, sin múltiples fotos en v1.**

**Venta sin stock suficiente: BLOQUEADA.** El sistema no permite completar una venta si
la cantidad pedida supera el stock disponible del producto. No hay opción de "vender
igual y quedar en negativo" ni de advertencia-pero-continuar.

## 4. Módulo: Ventas

Una venta es **de contado o a crédito** (se elige al capturarla, no cambia después).

### 4.1 Venta de contado
- Se cobra el total al momento. No genera saldo ni afecta la cuenta del cliente.
- Puede o no tener un cliente asociado (útil para el recibo, pero no obligatorio para
  saldo porque no genera ninguno). **[Nota: confirmar en TICKETS si el cliente es
  opcional en venta de contado — no se preguntó explícitamente; se asume opcional por
  default salvo que digas lo contrario.]**

### 4.2 Venta a crédito
- **Requiere cliente** (para poder atribuir el saldo a alguien).
- **Enganche: opcional**, decide el vendedor al capturar la venta — puede ser $0 o
  cualquier monto menor o igual al total.
- **Sin plazo ni fecha límite.** No hay campo de "fecha de vencimiento" ni plan de
  abonos programado — el cliente abona cuando puede.
- **Nunca genera recargos ni intereses por atraso** — el saldo de la venta es fijo desde
  que se crea, nunca crece con el tiempo.
- El monto pendiente de la venta (total − enganche) se **suma a la cuenta global** del
  cliente — no queda como un saldo aislado de esa venta en particular.

### 4.3 Reglas comunes a ambos tipos
- Cada venta genera un **folio único** `REC-XXXXXXXX` (ver sección 7).
- El vendedor de la venta es siempre quien está logueado al capturarla — nunca un campo
  elegible.
- Una venta tiene 1+ productos (detalle de línea: producto, cantidad, precio unitario al
  momento de la venta — snapshot, no referencia viva al precio actual del catálogo).
- Al confirmar la venta, el stock de cada producto vendido se descuenta de inmediato.

## 5. Módulo: Abonos

- **Cualquier vendedor puede registrar un abono de cualquier cliente** — no solo quien
  hizo la venta a crédito original. No hay "dueño" de un cliente.
- El abono se aplica contra la **cuenta global** del cliente, no contra una venta
  específica.
- **Validación de monto: el sistema RECHAZA un abono mayor al saldo pendiente actual del
  cliente.** No existe concepto de "saldo a favor" — si el cliente intenta pagar de más,
  la app no deja capturar ese monto (debe ajustar el monto exacto o menor).
- Cada abono genera su propio folio único `REC-XXXXXXXX` (mismo formato que una venta,
  sin prefijo que los distinga entre sí — ver sección 7).

## 6. Cancelaciones / anulaciones

- **Nunca se borra un registro físicamente.** Se marca como anulado (`anulado`,
  `anulado_por`, `anulado_en`) — mismo patrón ya usado en el resto de tus apps
  (`checklist_cumplimientos`, `preventivo_registros`, etc.), para nunca perder
  trazabilidad de qué pasó y quién lo corrigió.
- **Un vendedor puede anular su propio registro** (una venta o un abono que él mismo
  capturó).
- **Papá (admin) puede anular CUALQUIER registro**, de cualquier vendedor — es el
  respaldo si alguien ya no puede corregir su propio error o ya no está presente.
- **Efecto de anular sobre el saldo:**
  - Anular un **abono** revierte su efecto: el monto abonado se vuelve a sumar al saldo
    pendiente del cliente (como si nunca se hubiera pagado).
  - Anular una **venta a crédito** revierte su efecto: el monto que había quedado
    pendiente de esa venta se resta del saldo global del cliente. Los abonos que ya se
    hubieran aplicado a la cuenta del cliente **no se tocan** — como el saldo es global
    (no por venta), esos abonos simplemente siguen contando contra el saldo restante del
    cliente después del ajuste.
  - Anular una **venta de contado** no afecta ningún saldo (nunca generó uno) — solo
    queda marcada como anulada para efectos de reportes/historial. **[Nota: pendiente
    definir en TICKETS si anular una venta de contado también repone el stock vendido —
    se asume que SÍ por default, salvo que digas lo contrario.]**

## 7. Folios

- Formato: `REC-` + 8 caracteres alfanuméricos aleatorios (ej. `REC-A3F9K2P1`).
- **Mismo formato para venta y abono** — no hay prefijo que distinga el tipo de
  movimiento en el folio mismo (se distingue por la tabla/tipo de registro, no por el
  texto del folio).
- Generado por una función SQL (`generate_folio()`) que reintenta hasta garantizar
  unicidad antes de insertar — no generado en el cliente, para evitar el riesgo de
  colisión y mantener el folio corto y legible (ver nota de la sección de ajuste al
  inicio de este documento sobre por qué no se usa `crypto.randomUUID()` tal cual).
- Constraint `UNIQUE` real en la columna de folio de ventas y de abonos.

## 8. Recibos

- Se genera un recibo tanto para una **venta** como para un **abono**.
- Contenido: folio, fecha/hora, nombre del vendedor que atendió, nombre del cliente (si
  aplica), y:
  - Venta: lista de productos/cantidades/precio, total, enganche (si hubo), saldo
    pendiente resultante del cliente.
  - Abono: monto abonado, saldo pendiente restante del cliente después del abono.
- Incluye logo/nombre **"Lima's Sales"** en el encabezado del recibo (ver sección 15).
- Tres formas de entrega, todas disponibles:
  1. Ver en pantalla.
  2. Descargar como PDF (`html2canvas` + `jsPDF`).
  3. Compartir directo por WhatsApp (Web Share API, mismo patrón ya usado en tus otras
     apps — sin generar un link `wa.me` con límite de longitud).

## 9. Comportamiento offline

- **No es prioridad.** Registrar una venta o un abono **requiere conexión a internet en
  el momento** — sin cola offline, sin IndexedDB, sin sincronización diferida (a
  diferencia de "Registro Paros Correctivos").
- Sí es una PWA instalable (manifest + Service Worker manual) — la interfaz/shell puede
  cargar sin conexión, pero cualquier operación de escritura (venta, abono, alta de
  cliente/producto) exige internet activo en ese momento; si no hay conexión, la app debe
  avisarlo con un error claro, no fallar en silencio ni encolar para después.

## 10. Pantalla principal (dashboard)

Igual para los 4 usuarios (ver "todos ven todo" en sección 1) — **dashboard combinado**:
- Ventas y abonos del día (de todo el negocio, no solo del usuario logueado).
- Clientes con saldo pendiente (para saber a quién le toca cobrar).
- Accesos rápidos: "Nueva venta", "Nuevo abono".

**Navegación:** barra inferior fija de 4 pestañas — **Inicio** (este dashboard),
**Inventario**, **Clientes** (incluye ver/registrar abonos), **Reportes**. "Nueva venta"
no es una pestaña propia — se abre como acción rápida desde Inicio (ver sección 15).

## 11. Reportes

- Sin restricción de datos por rol — cualquier usuario ve el negocio completo.
- Contenido mínimo v1 (tablas/texto, sin gráficas — fuera de alcance en v1):
  - Total vendido (contado + crédito) por período.
  - Saldo total pendiente del negocio (suma de saldos de todos los clientes).
  - Listado de clientes con saldo pendiente, ordenado de mayor a menor.
  - Ventas y abonos agrupados por vendedor (visible para todos, no solo para Papá).

## 12. Casos límite — resumen explícito

| Caso | Comportamiento |
|---|---|
| Venta sin stock suficiente | Bloqueada, no se puede confirmar. |
| Producto sin foto o sin precio | No se puede guardar — ambos son obligatorios. |
| Cliente sin teléfono | Permitido, siempre opcional. |
| Dos clientes con el mismo nombre | Bloqueado — el nombre debe ser único, se pide diferenciarlo al capturar. |
| Abono mayor al saldo pendiente | Rechazado por el sistema, no se permite capturar. |
| Registro (venta/abono) capturado por error | Se anula (nunca se borra); el vendedor anula lo suyo, Papá anula cualquiera. |
| Venta a crédito atrasada en pagarse | Nunca genera recargo ni interés — el saldo es fijo. |
| Sin internet al momento de vender/abonar | La operación no se puede completar; se avisa con un error claro. |

## 13. Fuera de alcance (v1) — explícito

- RLS (seguridad a nivel de fila) en Supabase — se agrega en una fase posterior, según tu
  propia instrucción.
- Recargos o intereses por atraso en crédito.
- Saldo a favor por sobrepago (el sistema simplemente rechaza el monto excedente).
- Plazos o planes de pago programados (fechas de vencimiento, calendario de abonos).
- Código de barras/SKU, múltiples fotos por producto.
- Cola offline / sincronización sin conexión.
- Notificaciones push.
- Exportar reportes a Excel/CSV.
- Gráficas en reportes (solo tablas/texto en v1).
- Supabase Auth real con correo (se usa login simplificado en su lugar).
- Roles adicionales más allá de `admin`/`vendedor`.

## 14. Puntos confirmados (2026-07-25)

Estos dos detalles no se preguntaron explícitamente en la sesión de interrogación
original; se propuso una respuesta por default y quedaron **confirmados** antes de pasar
a TICKETS.md:

1. **¿El cliente es obligatorio en una venta de contado, o puede ser anónima/sin
   cliente?** Confirmado: **opcional** — una venta de contado puede no tener cliente
   asociado, ya que no genera saldo.
2. **¿Anular una venta de contado repone el stock vendido?** Confirmado: **sí** — el
   stock se regresa al anular cualquier venta (de contado o crédito), ya que la
   mercancía en realidad no salió del negocio.

## 15. Cambios de alcance confirmados (2026-07-26)

Después de que el ticket 01 (esquema) y 02 (PWA shell + login) ya estaban construidos,
el usuario compartió mockups de referencia y un logo real ("Lima's Sales", monograma LS
en degradado teal/cyan sobre navy oscuro). Esto cambió tres decisiones ya tomadas en el
SPEC original:

1. **Nombre de negocio visible — antes "anónimo", ahora "Lima's Sales" en todos lados.**
   Reemplaza la sección 1 original ("sin nombre de negocio visible en ningún lado").
   Aplica a: pantalla de login, header de la app, ícono de instalación (manifest) y
   encabezado del recibo.
2. **Categorías de producto — antes "sin categorías", ahora sí, como texto libre
   opcional.** No es una lista fija/taxonomía — es una etiqueta libre por producto para
   poder agrupar/filtrar en Inventario, consistente con que el negocio "vende lo que se
   encuentre" (no se le puso un catálogo cerrado de categorías).
3. **Navegación — no estaba definida, ahora es barra inferior fija de 4 pestañas**
   (Inicio / Inventario / Clientes / Reportes). Ver sección 10.

**Impacto en tickets ya completados:** el ticket 02 (PWA shell + login) requirió rework
— re-branding (logo/nombre/paleta) y agregar la estructura de navegación inferior. El
ticket 04 (Inventario) gana un criterio de aceptación nuevo (campo categoría).

## 16. Identidad visual café/crema + escritorio (2026-08-09)

El usuario compartió un sistema de diseño completo (paleta, tipografía, componentes,
reglas responsive) para adoptar como base visual permanente del proyecto — documentado
en [docs/superpowers/specs/2026-08-09-design-system-crm-familiar.md](docs/superpowers/specs/2026-08-09-design-system-crm-familiar.md).
Confirmado en simulación previa (variantes móvil/escritorio en café/crema):

1. **Paleta — de teal/cyan sobre navy a café/crema.** Se mantiene el nombre y logo
   "Lima's Sales" (monograma LS); solo cambian colores y tipografía (Arial → Inter).
2. **Layout de escritorio — nueva capacidad.** La app pasa de ser mobile-only a tener
   también un layout de escritorio/laptop con navegación lateral (sidebar), manteniendo
   el shell mobile-first actual sin cambios de estructura.
3. **Navegación móvil — sin cambios.** Se mantienen las 4 pestañas actuales (Inicio /
   Inventario / Clientes / Reportes); no se adopta el patrón alternativo de 5 pestañas
   con "Nueva venta" destacada que traía la imagen de referencia.

**Implementado (recoloreo, esta misma fecha):** `styles.css` (tokens de `:root` +
gradientes/badges hardcodeados), `index.html` (theme-color, fuente Inter vía Google
Fonts), `manifest.json` (theme_color/background_color), `icon.svg` (gradiente del
monograma LS). Verificado en `localhost:3000` — tokens, gradiente de botón primario y
color de error aplicando el valor exacto especificado, sin errores de consola.

**Implementado (layout de escritorio, esta misma fecha):** sidebar en pantallas
≥1024px reutilizando la navegación de pestañas existente (`switchTab()`/`initNav()` en
`app.js` sin cambios). Verificado en local (desktop y móvil, sin regresión) y confirmado
por Luis en producción — 2026-08-09, "se ve muy bien". Ver `TICKETS.md` tickets 21 y 22.

**Pendiente:** módulo CRM (sección 17).

## 17. Módulo CRM: contacto y seguimiento de clientes

Extiende el módulo Clientes (sección 2). Objetivo de negocio: hoy, cuando alguien
pregunta por un producto y no compra, esa información se pierde — nadie la anota, y
cuando llega mercancía parecida nadie se acuerda de avisarle. Este módulo existe para
que esa pregunta quede registrada y alguien vuelva a tocar el tema, en vez de perderse.

Decisiones confirmadas por Luis el 2026-08-09, sobre la simulación compartida.

> **Evaluación de flujo (2026-08-09):** antes de tocar Supabase, se revisó el flujo de
> captura/consulta de este módulo contra investigación real de por qué fallan los CRM en
> la práctica y patrones de UX de recordatorios. Se encontraron 3 problemas de fondo y se
> corrigieron aquí mismo (ver notas "⚠️ Corrección de flujo" en cada sub-sección) — el
> detalle completo del razonamiento vive en la conversación, resumen abajo:
> 1. **La captura tenía más fricción de la necesaria** — la única razón de ser de este
>    módulo es que alguien SÍ registre el contacto en el momento; cada campo obligatorio
>    de más es una razón para saltárselo bajo presión. Fuente: estudios de adopción de
>    CRM muestran que la entrada manual de datos es la causa #1 de que los vendedores
>    dejen de usarlo — [Coffee.ai](https://www.coffee.ai/articles/why-sales-reps-ignore-crm/),
>    [Clari](https://www.clari.com/blog/why-your-sales-teams-crm-adoption-is-low/).
> 2. **Dejar el "match de interés" para v2 mata el propósito del módulo antes de
>    empezar** — si nadie vuelve a ver lo que se capturó, se repite exactamente el
>    problema original (preguntas que se pierden), solo que ahora en una base de datos en
>    vez de en la cabeza de alguien. Se reincorpora una versión simplificada en 17.8.
> 3. **Una lista de "vencidos" que solo crece nunca deja de sentirse urgente — hasta que
>    deja de sentirse urgente para siempre** (fatiga de alertas): si un seguimiento lleva
>    semanas vencido junto a los de ayer, el ojo deja de distinguir cuál sí importa hoy.
>    Fuente: [Smashing Magazine — Notifications UX](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/),
>    revisión de fatiga de alertas en salud (mismo patrón, distinto dominio) —
>    [PMC 11845892](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11845892/). Se agregó el
>    bucket "Estancados" en 17.5.

### 17.1 Interacción (registro de contacto)

| Campo | Regla |
|---|---|
| Cliente | Obligatorio. Si quien pregunta no es cliente existente, se da de alta al vuelo (solo nombre, igual que hoy en el módulo Clientes). |
| Tipo | Uno de: **Preguntó por algo** / **Le ofrecí** / **Otro** — **preseleccionado en "Preguntó por algo"** (el caso más común); el vendedor solo lo toca si de verdad fue otra cosa. |
| Producto de interés | Texto libre, opcional — casi siempre el producto todavía no existe en Inventario, por eso no es una referencia a `productos`. |
| Nota | Texto libre, opcional. |
| Registrado por | El usuario que la captura (automático, igual que ventas/abonos — se resuelve server-side desde `auth.uid()`, nunca lo manda el cliente). |
| Fecha | Automática al guardar. |

**⚠️ Corrección de flujo — captura mínima viable:** con tipo preseleccionado y
seguimiento en "sí, 3 días" preseleccionado (ver 17.2), lo único que el vendedor
**tiene** que hacer para guardar es escribir qué le interesó al cliente y tocar Guardar
— dos acciones, no cinco. Todo lo demás (tipo, nota, fecha de seguimiento) es ajustar un
default, no llenar un formulario desde cero. Esto es intencional: el momento de
capturar (a media conversación, con el cliente enfrente o recién colgado WhatsApp) es el
peor momento para pedirle a alguien que piense en cinco decisiones.

### 17.2 Seguimiento

Al registrar una interacción, opcionalmente se marca "dar seguimiento" —
**preseleccionado en "sí, en 3 días"** (ver nota de 17.1; se puede cambiar a fecha
específica o quitar con un toque).

| Campo | Regla |
|---|---|
| Fecha de seguimiento | Atajo rápido "en 3 días" (**default**, preseleccionado) o fecha específica elegida a mano. |
| Estado | `pendiente` → `cerrado`. **"Vencido" no se guarda** — es calculado (`seguimiento_fecha < hoy AND estado = 'pendiente'`). |
| Cierre | Al cerrar: **Compró** o **No quiso** (nota opcional). También se puede **posponer** sin cerrar — solo cambia la fecha, el seguimiento sigue `pendiente`. |
| Vínculo con la venta (si "Compró") | Opcional. **No se escribe un folio a mano** — se ofrece un selector con las ventas recientes (últimos 7 días) de ese cliente para tocar una, o se cierra sin vincular ninguna. |

**⚠️ Corrección de flujo — evitar seguimientos duplicados sin bloquear:** si el cliente
ya tiene otro seguimiento `pendiente` al registrar uno nuevo, se muestra un aviso suave
("Ya tiene un seguimiento pendiente del 6 ago — ¿de todas formas crear uno nuevo?") en
vez de impedirlo — evita que la ficha se llene de seguimientos repetidos del mismo tema
sin agregar un candado rígido que estorbe en un caso legítimo (dos temas distintos).

**Visibilidad y permisos:** igual que el resto de la app — filosofía "todos ven todo"
(sección 1). Cualquier usuario puede ver y cerrar el seguimiento de cualquier otro, no
solo el propio. No aplica la restricción que sí tienen las anulaciones (sección 6),
porque cerrar un seguimiento no revierte dinero ni stock.

### 17.3 Cliente inactivo

Un cliente se marca visualmente como **inactivo** cuando no tiene ninguna venta no
anulada en los últimos **45 días**. Es un cálculo en tiempo real sobre `ventas.creado_en`,
no un campo almacenado.

### 17.4 Ficha de cliente (pantalla nueva)

Reemplaza el comportamiento actual de "tocar un cliente en la lista abre editar". Ahora
abre una ficha con tres bloques (misma estructura en móvil y escritorio, confirmada
sobre la simulación como variante única, sin dejar A/B/C a elegir):

1. **Tarjeta del cliente** — nombre, teléfono, saldo pendiente, accesos directos
   (WhatsApp, Registrar contacto, Editar).
2. **Próxima acción** — el seguimiento pendiente o vencido más próximo de ese cliente,
   fijo en pantalla (no se pierde al hacer scroll), con botones rápidos Compró / No
   quiso / Posponer.
3. **Historial combinado** — compras, abonos, contactos y seguimientos en orden
   cronológico, con pestañas (Todo / Compras / Contactos / Seguimientos) para filtrar.

El botón de editar (nombre/teléfono) sigue existiendo, ahora dentro de la ficha en vez de
ser la acción por default al tocar la fila.

### 17.5 Pantalla Seguimientos

Lista global de seguimientos pendientes de todos los clientes, agrupados en **Vencidos /
Para hoy / Próximos**. Accesible desde un acceso directo en Inicio.

**⚠️ Corrección de flujo — evitar fatiga de alertas:** los seguimientos vencidos hace
**más de 30 días** se muestran en un cuarto grupo aparte, **Estancados**, colapsado por
default y sin el color rojo de "urgente" — para que la sección Vencidos siga
significando "esto sí es reciente y sí importa hoy", en vez de volverse una lista larga
que nadie revisa. No se cierran solos (cerrar algo sin que un humano decida podría
ocultar un cliente real) — solo se separan visualmente.

### 17.6 Alertas en Inicio

Banner (mismo patrón visual que ya usa la app, ej. el de propuestas pendientes en MPM)
con el conteo de seguimientos para hoy y vencidos, con botón para ir directo a la
pantalla de Seguimientos. El conteo es **global** (todos los usuarios, no solo "los
míos") — consistente con la filosofía "todos ven todo".

### 17.7 Cliente inactivo → acción sugerida

Al ver un cliente marcado inactivo (17.3) en la ficha o en la lista de Clientes, el
único paso siguiente natural es registrar contacto para reactivarlo — así que el acceso
"Registrar contacto" queda igual de visible ahí que en cualquier otro cliente (no se
agrega un flujo especial). Se documenta aquí para que quien construya la UI no lo trate
como un callejón sin salida — un cliente inactivo sin ninguna acción disponible sería
solo una etiqueta triste, no algo accionable.

### 17.8 Sugerencia de interés al dar de alta un producto (v1, versión simplificada)

**⚠️ Corrección de flujo:** en el borrador anterior esto quedaba fuera de alcance v1,
dejando que el vendedor recordara manualmente a quién avisar cuando llega mercancía
parecida a algo que alguien pidió — es decir, **el mismo problema de memoria que este
módulo existe para resolver**, solo que un paso más adelante en el proceso. Sin esto, el
CRM corre el riesgo real de dejar de usarse en semanas: si capturar una pregunta nunca
se traduce en una venta recuperada que alguien note, no hay valor visible y la captura
se abandona (mismo patrón que documenta la investigación de adopción de CRM citada
arriba).

Versión v1 (barata, no es matching difuso ni tiempo real):

- Al guardar un producto nuevo en Inventario (`saveProducto()`), se hace **una sola
  búsqueda `ILIKE`** del nombre del producto contra `producto_interes` de interacciones
  con `seguimiento_estado = 'pendiente'`.
- Si hay coincidencias, un toast/aviso no bloqueante: *"N cliente(s) preguntaron algo
  parecido — revisar"*, con acceso directo a esa lista filtrada en Seguimientos.
- Es una **sugerencia para que un humano decida**, no un envío automático de nada — los
  falsos positivos/negativos de un `ILIKE` son aceptables porque el costo de un
  falso positivo es solo "revisar y descartar", no una acción irreversible.

### 17.9 Fuera de alcance v1 — explícito

- **Matching difuso o en tiempo real** (sinónimos, errores de dedo, coincidencia parcial
  inteligente) — la versión v1 de 17.8 es una búsqueda simple, no un motor de búsqueda.
- Reasignar un seguimiento a otro vendedor.
- Recordatorios push — mismo alcance ya definido en la sección 13 original.
- Reportes/métricas de conversión (preguntas → ventas) — posible v2, no v1.
