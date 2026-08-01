# Login en 2 pasos + versión visible — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el `<select>` plano del login por un flujo de 3 pasos (categoría →
nombre → contraseña) agrupado por rol, y mostrar la versión de la app con un botón para
forzar actualización — igual patrón que otra app de Luis.

**Architecture:** Todo dentro de la misma `.login-card` de `index.html` (sin vistas
nuevas) — se anima/oculta contenido interno según el paso activo. La versión de la app
pasa a vivir en un archivo nuevo de una línea (`version.js`) que tanto `sw.js` (Service
Worker) como `app.js` (módulo ES) leen, para no duplicar el número en dos lugares.

**Tech Stack:** HTML/CSS/JS planos sin build step, `@supabase/supabase-js` vía `esm.sh`,
Service Worker manual para caché e instalación PWA.

## Global Constraints

- Sin build step — no se introduce ningún bundler, transpilador ni framework nuevo.
- Convención de caché: cualquier cambio a `app.js`, `index.html`, `styles.css` o
  `sw.js` requiere subir el valor de versión antes del commit final. **A partir de este
  ticket, ese valor vive en `version.js`** (`self.CACHE_VERSION = 'vf-vX'`) — ya no se
  edita el string directo dentro de `sw.js`.
- Categorías del login = los roles reales que ya existen en `usuarios.rol`: `admin` y
  `vendedor`. No se inventan categorías nuevas.
- Si una categoría tiene exactamente un usuario activo, tocar su tarjeta salta directo
  al paso de contraseña (sin mostrar una lista de un solo nombre).
- Cerrar sesión siempre reinicia el login al paso 1 (categoría) — nunca deja "recordado"
  el paso en el que se quedó la sesión anterior.
- No hay test runner en este proyecto — la verificación es `node --check app.js` para
  sintaxis, más comprobación manual en navegador real (con las herramientas de preview)
  contra Supabase de producción.

---

### Task 1: `version.js` nuevo + `sw.js` lee la versión de ahí

**Files:**
- Create: `version.js`
- Modify: `sw.js:1`

**Interfaces:**
- Produce: `self.CACHE_VERSION` (string, ej. `'vf-v12'`) — disponible tanto en el
  contexto del Service Worker como en el contexto de página (ambos usan `self` como
  objeto global). Las Tasks 2 y 3 lo consumen.

- [ ] **Step 1: Crear `version.js`**

Contenido completo del archivo nuevo:

```js
// version.js — fuente única de la versión de la app.
// La lee sw.js (importScripts) y app.js (script clásico, antes del módulo).
// Al lanzar cambios: subir SOLO este valor.
self.CACHE_VERSION = 'vf-v12';
```

(Mismo valor que ya tenía `sw.js` — este primer paso solo mueve el número de lugar, no
lo cambia todavía. El bump real de versión ocurre en la Task 6, al cerrar el ticket.)

- [ ] **Step 2: Modificar `sw.js` para leer `CACHE_VERSION` de `version.js`**

Reemplaza la línea 1 de `sw.js`:

```js
const CACHE = 'vf-v12';
```

por:

```js
importScripts('./version.js');
const CACHE = self.CACHE_VERSION;
```

El resto de `sw.js` (líneas 2 en adelante: `SHELL`, `install`, `activate`, `fetch`) no
cambia.

- [ ] **Step 3: Verificar que el Service Worker sigue registrando sin errores**

No hay test runner — usa las herramientas de preview del navegador:

1. Abre la app en el navegador (`preview_start` apuntando a este directorio, o sirve
   con `npx serve .` si el preview no resuelve la carpeta correcta).
2. Abre la consola del navegador (`read_console_messages`) — no debe haber errores de
   `importScripts` ni de registro del Service Worker.
3. Ejecuta en la consola de la página (`javascript_tool`):
   ```js
   navigator.serviceWorker.getRegistration().then(r => r && r.active && r.active.scriptURL)
   ```
   Debe devolver la URL de `sw.js` sin error.
4. Verifica que `caches.keys()` incluya `'vf-v12'` (mismo valor que antes — confirma que
   `importScripts('./version.js')` cargó el valor correctamente, no `undefined`).

- [ ] **Step 4: Commit**

```bash
git add version.js sw.js
git commit -m "Ticket 15: mover la versión de sw.js a version.js compartido"
```

---

### Task 2: `index.html` — cargar `version.js` + login en 3 pasos

**Files:**
- Modify: `index.html:13` (agregar script antes de `link rel="stylesheet"` no aplica —
  ver Step 1 para la ubicación exacta)
- Modify: `index.html:17-39` (bloque completo de `#view-login`)
- Modify: `index.html:538` (agregar `<script src="version.js">` antes del script de
  `app.js`)

**Interfaces:**
- Consume: `self.CACHE_VERSION` (Task 1).
- Produce: ids nuevos que consume la Task 3 —
  `#login-version`, `#login-paso-categoria`, `.login-categoria-card` (con
  `data-rol="admin"` / `data-rol="vendedor"`), `#login-paso-nombre`,
  `#login-nombre-volver`, `#login-categoria-titulo`, `#login-nombre-list`,
  `#login-paso-password`, `#login-password-volver`, `#login-nombre-titulo`,
  `#login-buscar-actualizacion`. Los ids `#login-form`, `#login-password`,
  `#login-error`, `#login-submit` se conservan sin cambio (misma función que ya tienen
  hoy).

- [ ] **Step 1: Reemplazar el bloque `#view-login` (`index.html:18-39`)**

Reemplaza las líneas 18-39 completas (desde `<section id="view-login"...` hasta el
`</section>` que le corresponde) por:

```html
  <section id="view-login" class="view active">
    <div class="login-card">
      <div class="login-icon"><img src="icon.svg" alt="" /></div>
      <h1>Lima's Sales</h1>
      <p class="brand-sub">Gestión de ventas del negocio</p>
      <p class="login-version" id="login-version">—</p>

      <!-- Paso 1: categoría -->
      <div id="login-paso-categoria">
        <button type="button" class="login-categoria-card" data-rol="admin">Admin</button>
        <button type="button" class="login-categoria-card" data-rol="vendedor">Vendedores</button>
      </div>

      <!-- Paso 2: nombre (se salta si la categoría tiene un solo usuario activo) -->
      <div id="login-paso-nombre" style="display:none;">
        <div class="login-paso-header">
          <button type="button" id="login-nombre-volver" class="icon-btn-alt" aria-label="Volver">‹</button>
          <span id="login-categoria-titulo"></span>
        </div>
        <div id="login-nombre-list"></div>
      </div>

      <!-- Paso 3: contraseña -->
      <div id="login-paso-password" style="display:none;">
        <div class="login-paso-header">
          <button type="button" id="login-password-volver" class="icon-btn-alt" aria-label="Volver">‹</button>
          <span id="login-nombre-titulo"></span>
        </div>
        <form id="login-form" autocomplete="off">
          <div class="field">
            <label for="login-password">Contraseña</label>
            <input id="login-password" type="password" required />
          </div>
          <p id="login-error" class="error-msg"></p>
          <button id="login-submit" type="submit" class="btn btn-primary">Entrar</button>
        </form>
      </div>

      <button type="button" id="login-buscar-actualizacion" class="btn-link">🔄 Buscar actualización</button>
    </div>
  </section>
```

- [ ] **Step 2: Cargar `version.js` antes de `app.js`**

En `index.html`, justo antes de la línea `<script type="module" src="app.js"></script>`
(línea 538 antes de este cambio — confirma la línea exacta con `grep -n
"type=\"module\" src=\"app.js\""` ya que el Step 1 pudo haber corrido el número de
línea unas pocas líneas), agrega:

```html
  <script src="version.js"></script>
```

Debe quedar como script clásico (**sin** `type="module"`), para que
`self.CACHE_VERSION` quede en el objeto global `window`/`self` y el módulo `app.js`
(que sí puede leer el global, aunque no comparta el scope léxico de un script clásico)
lo encuentre.

- [ ] **Step 3: Verificar que el HTML balancea**

No hay test runner — confirma visualmente que el bloque reemplazado en el Step 1 tiene
exactamente 3 `<div>` de paso (`login-paso-categoria`, `login-paso-nombre`,
`login-paso-password`) y que cada uno cierra dentro del mismo bloque, y que el
`</section>` final de `#view-login` sigue presente una sola vez.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Ticket 15: HTML del login en 3 pasos + carga de version.js"
```

---

### Task 3: `app.js` — flujo de login de 3 pasos, versión y botón de actualización

**Files:**
- Modify: `app.js:66-92` (reemplaza `populateLoginUsuarios()` por las funciones nuevas
  del flujo)
- Modify: `app.js:94-138` (`handleLogin`)
- Modify: `app.js:140-145` (`handleLogout`)
- Modify: `app.js:2436-2473` (`init()`)

**Interfaces:**
- Consume: `self.CACHE_VERSION` (Task 1); ids de `index.html` de la Task 2; `supabase`,
  `toast`, `assertOnline`, `getSession`, `setSession`, `clearSession`, `showView`,
  `renderMain` (ya existen en `app.js`, sin cambios de firma).
- Produce: `loginRolActual` (string `'admin'|'vendedor'`|`null`), `loginNombreActual`
  (string|`null`), `loginCategoriasCache` (`{ admin: string[], vendedor: string[] }`),
  y las funciones `cargarLoginCategorias()`, `mostrarLoginPaso(paso)`,
  `abrirLoginCategoria(rol)`, `seleccionarLoginNombre(nombre)`,
  `volverALoginCategoria()`, `volverALoginNombre()`, `resetLoginFlow()`,
  `mostrarVersionLogin()`, `buscarActualizacion()` — ninguna otra tarea del plan las
  consume (Task 5 solo las ejercita desde el navegador).

- [ ] **Step 1: Reemplazar `populateLoginUsuarios()` (`app.js:66-92`) por el flujo de 3 pasos**

Localiza el bloque exacto en el archivo actual (empieza en el comentario
`// ---------- Login ----------` y termina justo antes de `async function
handleLogin`). Reemplázalo completo por:

```js
// ---------- Login ----------

let loginRolActual = null;
let loginNombreActual = null;
let loginCategoriasCache = { admin: [], vendedor: [] };

async function cargarLoginCategorias() {
  const { data, error } = await supabase
    .from('usuarios')
    .select('nombre, rol')
    .eq('activo', true)
    .order('nombre');

  loginCategoriasCache = { admin: [], vendedor: [] };
  if (!error && data) {
    data.forEach((u) => {
      if (loginCategoriasCache[u.rol]) loginCategoriasCache[u.rol].push(u.nombre);
    });
  }
}

function mostrarLoginPaso(paso) {
  document.getElementById('login-paso-categoria').style.display = paso === 'categoria' ? 'block' : 'none';
  document.getElementById('login-paso-nombre').style.display = paso === 'nombre' ? 'block' : 'none';
  document.getElementById('login-paso-password').style.display = paso === 'password' ? 'block' : 'none';
}

async function abrirLoginCategoria(rol) {
  await cargarLoginCategorias();
  const nombres = loginCategoriasCache[rol] || [];
  loginRolActual = rol;

  if (nombres.length === 1) {
    seleccionarLoginNombre(nombres[0]);
    return;
  }

  document.getElementById('login-categoria-titulo').textContent =
    rol === 'admin' ? 'Admin' : 'Vendedores';

  const list = document.getElementById('login-nombre-list');
  list.innerHTML = '';
  nombres.forEach((nombre) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'login-nombre-card';
    btn.textContent = nombre;
    btn.addEventListener('click', () => seleccionarLoginNombre(nombre));
    list.appendChild(btn);
  });

  mostrarLoginPaso('nombre');
}

function seleccionarLoginNombre(nombre) {
  loginNombreActual = nombre;
  document.getElementById('login-nombre-titulo').textContent = nombre;
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').textContent = '';
  mostrarLoginPaso('password');
  document.getElementById('login-password').focus();
}

function volverALoginCategoria() {
  loginRolActual = null;
  mostrarLoginPaso('categoria');
}

function volverALoginNombre() {
  const nombres = loginCategoriasCache[loginRolActual] || [];
  if (nombres.length === 1) {
    volverALoginCategoria();
    return;
  }
  mostrarLoginPaso('nombre');
}

function resetLoginFlow() {
  loginRolActual = null;
  loginNombreActual = null;
  mostrarLoginPaso('categoria');
}

function mostrarVersionLogin() {
  const v = (self.CACHE_VERSION || '').replace(/^vf-/, '');
  document.getElementById('login-version').textContent = v;
}

async function buscarActualizacion() {
  const btn = document.getElementById('login-buscar-actualizacion');

  if (!('serviceWorker' in navigator)) {
    toast('Este navegador no soporta actualizaciones automáticas.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Buscando...';

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      toast('No se pudo verificar. Intenta de nuevo.', 'error');
      return;
    }

    const huboActualizacion = await new Promise((resolve) => {
      let resuelto = false;
      const terminar = (valor) => {
        if (resuelto) return;
        resuelto = true;
        resolve(valor);
      };

      reg.addEventListener('updatefound', () => {
        const nuevoWorker = reg.installing;
        if (!nuevoWorker) { terminar(false); return; }
        nuevoWorker.addEventListener('statechange', () => {
          if (nuevoWorker.state === 'activated') terminar(true);
        });
      }, { once: true });

      reg.update().catch(() => terminar(false));
      setTimeout(() => terminar(false), 3000);
    });

    if (huboActualizacion) {
      toast('Actualizando...');
      window.location.reload();
    } else {
      toast('Ya tienes la última versión.');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Buscar actualización';
  }
}
```

- [ ] **Step 2: Reescribir `handleLogin()` para usar `loginNombreActual`**

Localiza `async function handleLogin(event) { ... }` (el bloque completo, ahora
desplazado unas líneas por el Step 1) y reemplázalo por:

```js
async function handleLogin(event) {
  event.preventDefault();
  if (!assertOnline()) return;

  const nombre = loginNombreActual;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Entrando...';

  try {
    const { data, error } = await supabase.rpc('login_usuario', {
      p_nombre: nombre,
      p_password: password,
    });

    if (error) {
      errorEl.textContent = 'No se pudo iniciar sesión. Intenta de nuevo.';
      return;
    }

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
    resetLoginFlow();
    renderMain(user);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Entrar';
  }
}
```

(Único cambio de lógica respecto a la versión actual: `nombre` ya no lee
`document.getElementById('login-nombre').value` — usa `loginNombreActual`; y se agrega
`resetLoginFlow();` justo antes de `renderMain(user);`.)

- [ ] **Step 3: Reescribir `handleLogout()`**

Reemplaza el bloque completo:

```js
function handleLogout() {
  clearSession();
  historialCache = [];
  resetLoginFlow();
  showView('view-login');
}
```

(Cambia `populateLoginUsuarios();` por `resetLoginFlow();`.)

- [ ] **Step 4: Actualizar `init()` con el wiring nuevo**

Localiza `function init() { ... }` (el bloque completo al final del archivo) y
reemplázalo por:

```js
function init() {
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.querySelectorAll('.login-categoria-card').forEach((btn) => {
    btn.addEventListener('click', () => abrirLoginCategoria(btn.dataset.rol));
  });
  document.getElementById('login-nombre-volver').addEventListener('click', volverALoginCategoria);
  document.getElementById('login-password-volver').addEventListener('click', volverALoginNombre);
  document.getElementById('login-buscar-actualizacion').addEventListener('click', buscarActualizacion);
  initNav();
  initClientes();
  initInventario();
  initVentas();
  initAbonos();
  initHistorial();
  initReportes();
  initCuenta();
  initMovimientos();

  mostrarVersionLogin();
  resetLoginFlow();
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
```

- [ ] **Step 5: Verificar sintaxis**

```bash
node --check app.js
```

Esperado: sin salida (sintaxis válida). Si falla, revisa que no haya quedado ninguna
llave o paréntesis sin cerrar de los reemplazos anteriores.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "Ticket 15: flujo de login en 3 pasos, versión visible y botón de actualización"
```

---

### Task 4: `styles.css` — estilos del login nuevo

**Files:**
- Modify: `styles.css:139-140` (inserta antes de `/* ---------- Main shell ---------- */`,
  dentro de la sección `/* ---------- Login ---------- */` que empieza en la línea 42)

**Interfaces:**
- Consume: variables ya existentes `--muted`, `--border`, `--bg`, `--card`, `--text`,
  `--accent`, `--accent-dark` (definidas en `:root`, sin cambios).
- Produce: clases `.login-version`, `.login-categoria-card`, `.login-nombre-card`,
  `.login-paso-header`, `.btn-link` — consumidas por el HTML de la Task 2.

- [ ] **Step 1: Insertar las clases nuevas**

Justo antes de la línea `/* ---------- Main shell ---------- */` (después de la regla
`.error-msg { ... }` existente), agrega:

```css
.login-version {
  font-size: 12px;
  color: var(--muted);
  margin: -12px 0 20px;
}

.login-categoria-card,
.login-nombre-card {
  display: block;
  width: 100%;
  padding: 18px 16px;
  margin-bottom: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.login-categoria-card:active,
.login-nombre-card:active {
  background: var(--card);
  border-color: var(--accent);
}

.login-paso-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  text-align: left;
}

.login-paso-header span {
  font-weight: 600;
  color: var(--text);
}

.btn-link {
  width: 100%;
  margin-top: 16px;
  padding: 8px;
  border: none;
  background: transparent;
  color: var(--accent-dark);
  font-size: 13px;
  cursor: pointer;
}
```

No se toca `.icon-btn-alt` — ya existe (usado hoy en el selector de mes de Reportes) y
se reutiliza tal cual para las flechas "‹" del login.

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "Ticket 15: estilos del login en 3 pasos"
```

---

### Task 5: Verificación manual completa en navegador real

**Files:**
- Ninguno (solo verificación).

**Interfaces:**
- Ninguna.

- [ ] **Step 1: Levantar el preview y confirmar que sirve el código correcto**

Usa las herramientas de preview del navegador. **Importante:** verifica primero que el
servidor de preview esté sirviendo los archivos de este directorio de trabajo y no una
copia vieja en otra ruta — compara `curl -s http://localhost:<puerto>/sw.js | head -1`
contra el contenido real de `sw.js` en disco antes de continuar (en un ticket anterior
de este mismo proyecto el preview terminó sirviendo el directorio equivocado).

- [ ] **Step 2: Login fresco — paso 1**

Abre la app sin sesión activa (`localStorage.clear()` en la consola si hace falta).
Confirma con `read_page`/`get_page_text` que se ven exactamente dos tarjetas: "Admin" y
"Vendedores", el texto de versión (ej. "v12"), y el botón "🔄 Buscar actualización" —
sin el `<select>` viejo.

- [ ] **Step 3: Categoría con un solo usuario (Admin) salta el paso de nombre**

Toca la tarjeta "Admin". Confirma que aparece directo el paso de contraseña con "Papá"
como título (no debe aparecer una pantalla intermedia con un solo botón "Papá").

- [ ] **Step 4: Categoría con varios usuarios (Vendedores) muestra la lista**

Vuelve al paso 1 (recarga o cierra sesión si ya entraste), toca "Vendedores". Confirma
que aparecen los nombres de los vendedores activos (Angie, Alexa, Alexis, Regina — o los
que estén activos en ese momento) como tarjetas independientes. Toca uno (ej. "Angie") y
confirma que el paso de contraseña muestra "Angie" como título.

- [ ] **Step 5: Navegación con flechas "‹"**

Desde el paso de contraseña de un vendedor, toca "‹" — confirma que regresa a la lista
de nombres de "Vendedores" (no a categoría). Desde ahí, toca "‹" otra vez — confirma que
regresa al paso 1 (categoría). Repite desde "Admin": toca "Admin" (salta a contraseña
por el atajo de 1 usuario) y toca "‹" — confirma que regresa directo a categoría (no a
una lista de nombres vacía o de un solo elemento).

- [ ] **Step 6: Login exitoso sigue funcionando**

Completa el login con un usuario real y su contraseña real (pide la contraseña vigente
si hace falta — no la adivines ni la busques en la base de datos). Confirma que entra
correctamente al dashboard, sin errores en consola (`read_console_messages`).

- [ ] **Step 7: Logout resetea el flujo**

Cierra sesión. Confirma que el login vuelve a mostrar el paso 1 (categoría) — no el
paso de contraseña ni la lista de nombres donde se había quedado antes de entrar.

- [ ] **Step 8: Botón "Buscar actualización" — ya al día**

Sin haber cambiado `version.js` desde que cargó la página, toca "🔄 Buscar
actualización". Confirma el toast "Ya tienes la última versión." y que la página NO se
recarga.

- [ ] **Step 9: Botón "Buscar actualización" — con versión nueva disponible**

Cambia temporalmente el valor de `version.js` en disco (ej. `'vf-v12'` → `'vf-v12-test'`)
sin hacer commit todavía. Recarga la página una vez para que el navegador tenga la
versión vieja activa, luego, SIN recargar de nuevo, toca "🔄 Buscar actualización".
Confirma el toast "Actualizando..." seguido de un reload automático, y que después del
reload el texto de versión mostró el nuevo valor. **Revierte el cambio temporal de
`version.js` a `'vf-v12'` antes de continuar** (era solo para esta prueba, no debe
quedar en el commit final).

- [ ] **Step 10: Revisión de consola sin errores**

`read_console_messages` con `onlyErrors: true` en cada paso anterior — debe estar vacío
en todos.

---

### Task 6: Cache bump final y despliegue

**Files:**
- Modify: `version.js`

**Interfaces:**
- Ninguna — task de cierre.

- [ ] **Step 1: Subir la versión**

En `version.js`, cambia:

```js
self.CACHE_VERSION = 'vf-v12';
```

por:

```js
self.CACHE_VERSION = 'vf-v13';
```

- [ ] **Step 2: Verificar una vez más en navegador que el texto de versión muestra "v13"**

Recarga la página (con el Service Worker viejo todavía activo, la primera carga puede
seguir mostrando "v12" hasta que el propio Service Worker se actualice — usa el botón
"🔄 Buscar actualización" de la Task 5 Step 9 para confirmar que termina en "v13").

- [ ] **Step 3: Commit y push**

```bash
git add version.js
git commit -m "Ticket 15: bump de versión a vf-v13"
git push
```

Esto dispara el redeploy automático en Vercel (`ventas-familia.vercel.app`). No hace
falta ningún paso manual adicional en Vercel.

- [ ] **Step 4: Actualizar TICKETS.md y CLAUDE.md**

En `TICKETS.md`, agrega el ticket 15 a la lista de completados con su checklist (mismo
formato que los tickets 13/14 anteriores) — cubrir: login en 3 pasos por rol, atajo de
1 usuario, versión visible vía `version.js` compartido, botón de actualización manual.
En `CLAUDE.md` (sección "Progreso"), añade "15 (login en 2 pasos + versión visible)" a
la lista de completados y actualiza la línea de "Pendiente" si aplica.
