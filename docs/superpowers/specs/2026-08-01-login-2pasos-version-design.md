# Diseño — Ticket 15: Login en 2 pasos (categoría → nombre) + versión visible

> Cambia el diseño visual del login, marcado en CLAUDE.md como "NO MODIFICAR sin
> consultar a Luis" — este cambio tiene su autorización explícita, pedida por Luis en
> esta sesión a partir de una captura de referencia de otra de sus apps ("LUIS LIMA —
> Gestión de Mantenimiento").

## 1. Contexto y problema

El login actual (`index.html` `#view-login`) es un `<select>` plano con todos los
nombres mezclados, sin agrupar, más un campo de contraseña — todo en un solo paso.
Luis quiere replicar el patrón de dos pasos de su otra app: elegir una categoría
grande y táctil, luego el nombre dentro de esa categoría, luego contraseña. También
quiere que el login muestre la versión de la app y tenga un botón para forzar la
actualización del Service Worker, igual que esa otra app.

## 2. Decisiones tomadas en esta sesión

1. **Categorías = los dos roles reales del proyecto**: "Admin" (`rol = 'admin'`) y
   "Vendedores" (`rol = 'vendedor'`) — no se inventan categorías nuevas; se reutiliza
   la columna `usuarios.rol` que ya existe.
2. **Atajo con un solo nombre**: si una categoría tiene exactamente un usuario activo
   (hoy es el caso de "Admin", con solo Papá), tocar la tarjeta de categoría salta
   directo al paso de contraseña — no se muestra la pantalla intermedia de "elige tu
   nombre" con un solo botón. Si esa categoría llega a tener 2+ usuarios activos en el
   futuro (ej. se da de alta un segundo admin), automáticamente vuelve a mostrar los 3
   pasos sin cambiar código.
3. **Versión = una sola fuente**, sin duplicar contador. Nuevo archivo `version.js`
   (una línea) que declara `self.CACHE_VERSION = 'vf-v12'` — tanto `sw.js` (vía
   `importScripts`) como `app.js` lo leen de ahí. El login muestra `v12` (se le quita
   el prefijo `vf-` para la pantalla). Subir la versión sigue siendo un solo paso: subir
   el valor en `version.js` (ya no se edita el string directo dentro de `sw.js`).
4. **Botón "🔄 Buscar actualización"**: llama a `registration.update()` para forzar al
   navegador a revisar si `sw.js`/`version.js` cambiaron en el servidor. Si aparece una
   versión nueva, dentro del sw.js existente (`skipWaiting` + `clients.claim`, sin
   cambios) se activa sola y la página recarga. Si no hay nada nuevo en ~3 segundos,
   muestra un toast "Ya tienes la última versión." sin recargar.
5. **Navegación entre pasos**: flecha "‹" (reutiliza la clase `.icon-btn-alt` que ya
   existe, usada hoy en el selector de mes de Reportes) para volver al paso anterior.
   Cerrar sesión (`handleLogout`) siempre regresa al paso 1 (categoría), nunca deja al
   siguiente login "recordando" el paso en el que se quedó el usuario anterior.
6. **Todo dentro de la misma `.login-card`** — no se crean vistas nuevas (`.view`), solo
   se anima/oculta contenido interno, igual patrón que ya usan los overlays de
   `paso-armar`/`paso-recibo` en Ventas y Abonos.

## 3. Archivo nuevo

```js
// version.js — fuente única de la versión de la app.
// La lee sw.js (importScripts) y app.js (script clásico, antes del módulo).
// Al lanzar cambios: subir SOLO este valor.
self.CACHE_VERSION = 'vf-v12';
```

## 4. Cambios en `sw.js`

```js
importScripts('./version.js');
const CACHE = self.CACHE_VERSION;
```

(Reemplaza la línea `const CACHE = 'vf-v12';` actual — el resto de `sw.js` no cambia.)

## 5. Cambios en `index.html`

- Agregar `<script src="version.js"></script>` **antes** de
  `<script type="module" src="app.js"></script>` (script clásico, no módulo — para que
  `self.CACHE_VERSION` quede en el objeto global `self`/`window` y `app.js`, como
  módulo, pueda leerlo).
- Reemplazar el contenido de `#view-login` `.login-card` (desde el `<form
  id="login-form">` actual) por tres bloques internos + el texto de versión + el botón
  de actualizar:

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

`login-categoria-titulo`/`login-nombre-titulo` muestran "Admin"/"Vendedores" y el
nombre elegido respectivamente, para que el usuario sepa dónde está parado al volver.

## 6. Cambios en `app.js`

### Reemplaza `populateLoginUsuarios()` por el flujo de 3 pasos

```js
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
  // Si la categoría actual tenía un solo nombre, "volver" desde password
  // regresa a categoría directo (no hay paso de nombre que mostrar).
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
```

### `handleLogin()` — usa `loginNombreActual` en vez de leer el `<select>`

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

(Único cambio real respecto a la versión actual: la línea que leía
`document.getElementById('login-nombre').value` ahora usa `loginNombreActual`, y se
agrega `resetLoginFlow()` justo antes de `renderMain(user)` para que la próxima vez que
alguien cierre sesión, el login no recuerde el paso anterior.)

### `handleLogout()` — resetea el flujo en vez de repoblar un `<select>`

```js
function handleLogout() {
  clearSession();
  historialCache = [];
  resetLoginFlow();
  showView('view-login');
}
```

### Versión en pantalla

```js
function mostrarVersionLogin() {
  const v = (self.CACHE_VERSION || '').replace(/^vf-/, '');
  document.getElementById('login-version').textContent = v;
}
```

(`CACHE_VERSION` ya viene como `'vf-v12'` — quitarle el prefijo `vf-` deja exactamente
`v12`, listo para mostrar tal cual.)

### Botón "Buscar actualización"

```js
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

### `init()` — wiring nuevo, reemplaza la línea `populateLoginUsuarios()`

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
    // ... sin cambios ...
    renderMain(session);
  } else {
    showView('view-login');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
```

`cargarLoginCategorias()` ya no se llama en `init()` de entrada — se llama dentro de
`abrirLoginCategoria()`, justo cuando el usuario toca una tarjeta, para tener siempre la
lista de usuarios activos más reciente sin pedirla de más en cada carga de la página.

## 7. CSS nuevo (`styles.css`, sección `/* ---------- Login ---------- */`)

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

(`.icon-btn-alt` ya existe — se reutiliza tal cual para las flechas "‹".)

## 8. Casos de prueba

- Login fresco (sin sesión): se ve el paso 1 con dos tarjetas, "Admin" y "Vendedores".
- Tocar "Admin" (hoy con un solo usuario activo, Papá) → salta directo a pedir
  contraseña, con "Papá" como título del paso.
- Tocar "Vendedores" (4 usuarios activos) → muestra la lista de 4 nombres; tocar uno
  lleva a contraseña con ese nombre como título.
- Flecha "‹" desde contraseña (categoría con 2+ nombres) → vuelve a la lista de
  nombres de esa categoría, no a categoría.
- Flecha "‹" desde contraseña (categoría con 1 solo nombre, ej. Admin) → vuelve
  directo a categoría (no existe una lista de un solo nombre que mostrar).
- Flecha "‹" desde la lista de nombres → vuelve a categoría.
- Login exitoso → `handleLogin` sigue llamando `login_usuario` con el nombre correcto;
  comportamiento de sesión/almacén sin cambios.
- Cerrar sesión → login siguiente arranca en paso 1 (categoría), nunca en el paso
  donde se quedó el usuario anterior.
- Se da de alta un segundo admin (ticket 12, "Mi cuenta" → Usuarios) → la próxima vez
  que alguien toque "Admin" ya no salta directo, muestra la lista con los 2 nombres.
- Texto de versión muestra "v12" (o el valor vigente de `CACHE_VERSION` sin el prefijo
  `vf-`).
- Botón "Buscar actualización" con la versión ya al día → toast "Ya tienes la última
  versión.", sin recargar.
- Botón "Buscar actualización" después de subir `version.js` en el servidor → detecta
  el cambio, muestra "Actualizando...", recarga sola con la versión nueva visible.
- Sin conexión a internet: `handleLogin` sigue bloqueado por `assertOnline()` como hoy;
  `buscarActualizacion()` con `serviceWorker` no soportado o sin registro válido muestra
  un mensaje de error claro, sin colgarse.

## 9. Fuera de alcance (explícito)

- Recordar la última categoría/nombre usado entre sesiones (localStorage) — cada visita
  al login arranca limpio en el paso 1.
- Buscador o filtro de nombres dentro de una categoría — con máximo unos cuantos
  vendedores no hace falta.
- Fotos/avatares por usuario en las tarjetas de nombre — solo texto, como hoy.
- Cambiar el criterio de agrupación en el futuro (ej. por almacén en vez de por rol) —
  si Luis lo pide más adelante, es un cambio de spec aparte.
- Notificación push o banner de "hay una actualización disponible" sin que el usuario
  presione el botón — el chequeo es siempre manual, a petición del usuario.
