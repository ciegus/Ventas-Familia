import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import html2canvas from 'https://esm.sh/html2canvas@1';
import { jsPDF } from 'https://esm.sh/jspdf@2';

const SUPABASE_URL = 'https://wiewxgkiefsjeonirsid.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpZXd4Z2tpZWZzamVvbmlyc2lkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMzY1MTQsImV4cCI6MjEwMDYxMjUxNH0.EM-_AV-yzKe0o-dT9EGiyhUA3djwZTVyWehzdVrGaIA';
const SESSION_KEY = 'vf_user';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Toast ----------

let toastTimer = null;

export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('toast-error', kind === 'error');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- Conexión ----------
// Cualquier operación de escritura (venta, abono, alta de cliente/producto) exige
// internet activo en ese momento — sin cola offline (SPEC sección 9).

export function assertOnline() {
  if (!navigator.onLine) {
    toast('Sin conexión a internet. Esta acción requiere estar en línea.', 'error');
    return false;
  }
  return true;
}

// ---------- Sesión ----------

export function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ---------- Vistas ----------

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function renderMain(user) {
  document.getElementById('main-nombre').textContent = user.nombre;
  document.getElementById('main-rol').textContent =
    user.rol === 'admin' ? 'Gerente' : 'Vendedor';
  switchTab('inicio');
  showView('view-main');
}

// ---------- Login ----------

let loginRolActual = null;
let loginNombreActual = null;
let loginCategoriasCache = { admin: [], vendedor: [] };

async function cargarLoginCategorias() {
  // RPC angosta (no select directo a `usuarios`) — RLS restringe esa tabla a
  // `authenticated` y en este punto todavía no hay sesión (ticket 17, fase C).
  const { data, error } = await supabase.rpc('listar_login_categorias');

  loginCategoriasCache = { admin: [], vendedor: [] };
  if (!error && data) {
    data.forEach((u) => {
      if (loginCategoriasCache[u.rol]) loginCategoriasCache[u.rol].push(u.nombre);
    });
  } else if (error) {
    toast('No se pudo cargar la lista de usuarios.', 'error');
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

// Ticket 17 (docs/superpowers/specs/2026-08-03-auth-real-rls-design.md): el nombre
// elegido en el paso 2 del login se traduce a un correo interno, nunca visible ni
// pedido al usuario — es solo el identificador que exige Supabase Auth.
function correoSintetico(nombre) {
  return `${nombre.trim().toLowerCase().replace(/\s+/g, '-')}@ventasfamilia.internal`;
}

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
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: correoSintetico(nombre),
      password,
    });

    if (authError) {
      errorEl.textContent = 'Usuario o contraseña incorrectos.';
      return;
    }

    // El perfil de negocio (id usado en ventas/abonos/etc., rol, activo) sigue
    // viviendo en `usuarios` — Fase C es la que mueve las funciones SQL a auth.uid().
    const { data: perfil, error: perfilError } = await supabase
      .from('usuarios')
      .select('id, nombre, rol, activo')
      .eq('nombre', nombre)
      .single();

    if (perfilError || !perfil || !perfil.activo) {
      await supabase.auth.signOut();
      errorEl.textContent = 'Usuario o contraseña incorrectos.';
      return;
    }

    const { data: almacenData } = await supabase
      .from('almacenes')
      .select('id')
      .eq('usuario_id', perfil.id)
      .single();

    const user = {
      id: perfil.id,
      nombre: perfil.nombre,
      rol: perfil.rol,
      almacenId: almacenData ? almacenData.id : null,
    };

    setSession(user);
    document.getElementById('login-form').reset();
    resetLoginFlow();
    renderMain(user);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Entrar';
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
  clearSession();
  historialCache = [];
  resetLoginFlow();
  showView('view-login');
}

// ---------- Navegación (barra inferior de 4 pestañas) ----------

function switchTab(tabName) {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  document.querySelectorAll('.fab').forEach((fab) => {
    fab.classList.toggle('show', fab.dataset.fabFor === tabName);
  });

  if (tabName === 'inventario') {
    const session = getSession();
    document.getElementById('fab-nuevo-producto').classList.toggle('show', !!session && session.rol === 'admin');
  }

  if (tabName === 'clientes') loadClientes();
  if (tabName === 'inventario') loadProductos();
  if (tabName === 'inicio') loadDashboard();
  if (tabName === 'reportes') loadReportes();
}

function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

// ---------- Dashboard (Inicio) ----------
// Ventas/abonos del día (todo el negocio) + clientes con saldo pendiente (SPEC sección 10).

async function loadDashboard() {
  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  const inicioDiaISO = inicioDia.toISOString();

  const [
    { data: ventasHoy, error: ventasError },
    { data: abonosHoy, error: abonosError },
    { data: clientesSaldo, error: clientesError },
  ] = await Promise.all([
    supabase.from('ventas').select('total')
      .eq('anulado', false).gte('creado_en', inicioDiaISO),
    supabase.from('abonos').select('monto')
      .eq('anulado', false).gte('creado_en', inicioDiaISO),
    supabase.from('clientes').select('id, nombre, saldo_pendiente')
      .gt('saldo_pendiente', 0).order('saldo_pendiente', { ascending: false }),
  ]);

  if (ventasError || abonosError || clientesError) {
    toast('No se pudo cargar el dashboard.', 'error');
    return;
  }

  renderDashboardStats(ventasHoy || [], abonosHoy || []);
  renderDashboardSaldos(clientesSaldo || []);
}

function renderDashboardStats(ventasHoy, abonosHoy) {
  const totalVentas = ventasHoy.reduce((sum, v) => sum + Number(v.total), 0);
  const totalAbonos = abonosHoy.reduce((sum, a) => sum + Number(a.monto), 0);

  document.getElementById('dash-ventas-total').textContent = money.format(totalVentas);
  document.getElementById('dash-ventas-count').textContent =
    `${ventasHoy.length} venta${ventasHoy.length === 1 ? '' : 's'}`;
  document.getElementById('dash-abonos-total').textContent = money.format(totalAbonos);
  document.getElementById('dash-abonos-count').textContent =
    `${abonosHoy.length} abono${abonosHoy.length === 1 ? '' : 's'}`;
}

function renderDashboardSaldos(clientes) {
  const list = document.getElementById('dash-saldos-list');
  const empty = document.getElementById('dash-saldos-empty');

  list.innerHTML = '';
  empty.style.display = clientes.length === 0 ? 'block' : 'none';

  clientes.forEach((cliente) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(cliente.nombre)}</div>
      </div>
      <div class="li-badge pendiente">${money.format(Number(cliente.saldo_pendiente))}</div>
    `;
    list.appendChild(item);
  });
}

// ---------- Clientes ----------

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
let clienteEditId = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadClientes() {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nombre, telefono, saldo_pendiente')
    .order('nombre');

  if (error) {
    toast('No se pudo cargar la lista de clientes.', 'error');
    return;
  }

  renderClientesList(data || []);
}

function renderClientesList(clientes) {
  const list = document.getElementById('clientes-list');
  const empty = document.getElementById('clientes-empty');

  list.innerHTML = '';
  empty.style.display = clientes.length === 0 ? 'block' : 'none';

  clientes.forEach((cliente) => {
    const saldo = Number(cliente.saldo_pendiente) || 0;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(cliente.nombre)}</div>
        <div class="li-sub">${cliente.telefono ? escapeHtml(cliente.telefono) : 'Sin teléfono'}</div>
      </div>
      <div class="li-badge ${saldo > 0 ? 'pendiente' : 'al-dia'}">
        ${saldo > 0 ? money.format(saldo) : 'Al día'}
      </div>
    `;
    item.addEventListener('click', () => openClienteForm(cliente));
    list.appendChild(item);
  });
}

function openClienteForm(cliente = null) {
  clienteEditId = cliente ? cliente.id : null;
  document.getElementById('cliente-form-title').textContent = cliente ? 'Editar cliente' : 'Nuevo cliente';
  document.getElementById('cliente-nombre').value = cliente ? cliente.nombre : '';
  document.getElementById('cliente-telefono').value = cliente ? (cliente.telefono || '') : '';
  document.getElementById('cliente-form-error').textContent = '';
  document.getElementById('cliente-sheet').classList.add('show');
}

function closeClienteForm() {
  document.getElementById('cliente-sheet').classList.remove('show');
}

async function saveCliente() {
  if (!assertOnline()) return;

  const nombre = document.getElementById('cliente-nombre').value.trim();
  const telefono = document.getElementById('cliente-telefono').value.trim();
  const errorEl = document.getElementById('cliente-form-error');
  const saveBtn = document.getElementById('cliente-guardar');

  errorEl.textContent = '';

  if (!nombre) {
    errorEl.textContent = 'El nombre es obligatorio.';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

  try {
    const payload = { nombre, telefono: telefono || null };
    const query = clienteEditId
      ? supabase.from('clientes').update(payload).eq('id', clienteEditId)
      : supabase.from('clientes').insert(payload);

    const { error } = await query;

    if (error) {
      if (error.code === '23505') {
        errorEl.textContent =
          'Ya existe un cliente con ese nombre. Si es una persona distinta, diferéncialo ' +
          'con un apodo o inicial (ej. "Juan Pérez (papelería)").';
      } else {
        errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
      }
      return;
    }

    closeClienteForm();
    toast(clienteEditId ? 'Cliente actualizado.' : 'Cliente agregado.');
    loadClientes();
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar';
  }
}

function initClientes() {
  document.getElementById('fab-nuevo-cliente').addEventListener('click', () => openClienteForm());
  document.getElementById('cliente-cancelar').addEventListener('click', closeClienteForm);
  document.getElementById('cliente-guardar').addEventListener('click', saveCliente);
}

// ---------- Inventario ----------

let productosCache = [];
let categoriaFiltroActual = null;
let productoEditId = null;
let productoFotoUrlActual = null;
let productoFotoBlobComprimido = null;

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

function renderFiltrosCategoria() {
  const categorias = [...new Set(productosCache.map((p) => p.categoria).filter(Boolean))].sort();
  const cont = document.getElementById('inventario-filtros');
  cont.innerHTML = '';

  if (categorias.length === 0) {
    categoriaFiltroActual = null;
    return;
  }

  const chips = ['Todos', ...categorias];
  chips.forEach((cat) => {
    const isTodos = cat === 'Todos';
    const btn = document.createElement('button');
    btn.className = 'chip' + ((isTodos && !categoriaFiltroActual) || cat === categoriaFiltroActual ? ' active' : '');
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      categoriaFiltroActual = isTodos ? null : cat;
      renderFiltrosCategoria();
      renderProductosGrid();
    });
    cont.appendChild(btn);
  });
}

function renderProductosGrid() {
  const grid = document.getElementById('inventario-grid');
  const empty = document.getElementById('inventario-empty');
  const productos = categoriaFiltroActual
    ? productosCache.filter((p) => p.categoria === categoriaFiltroActual)
    : productosCache;

  grid.innerHTML = '';
  empty.style.display = productosCache.length === 0 ? 'block' : 'none';

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
}

function openProductoForm(producto = null) {
  productoEditId = producto ? producto.id : null;
  productoFotoUrlActual = producto ? producto.foto_url : null;
  productoFotoBlobComprimido = null;

  document.getElementById('producto-form-title').textContent = producto ? 'Editar producto' : 'Nuevo producto';
  document.getElementById('producto-nombre').value = producto ? producto.nombre : '';
  document.getElementById('producto-precio').value = producto ? producto.precio : '';
  document.getElementById('producto-costo').value = producto ? producto.costo : '';
  document.getElementById('producto-stock-row').style.display = producto ? 'none' : 'block';
  document.getElementById('producto-stock').value = producto ? '' : '';
  document.getElementById('producto-categoria').value = producto ? (producto.categoria || '') : '';
  document.getElementById('producto-foto').value = '';
  document.getElementById('producto-form-error').textContent = '';

  const preview = document.getElementById('producto-foto-preview');
  if (producto && producto.foto_url) {
    preview.src = producto.foto_url;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }

  document.getElementById('producto-stock-almacenes-row').style.display = producto ? 'block' : 'none';
  document.getElementById('producto-entrada-row').style.display =
    producto && getSession().rol === 'admin' ? 'block' : 'none';
  document.getElementById('producto-entrada-cantidad').value = '';
  document.getElementById('producto-entrada-error').textContent = '';
  if (producto) loadStockPorAlmacen(producto.id);

  document.getElementById('producto-sheet').classList.add('show');
}

function closeProductoForm() {
  document.getElementById('producto-sheet').classList.remove('show');
}

function nombreAlmacen(a) {
  return a.usuario_id ? a.usuarios.nombre : 'Central';
}

async function loadStockPorAlmacen(productoId) {
  const [{ data: almacenes, error: almError }, { data: stock, error: stockError }] = await Promise.all([
    supabase.from('almacenes').select('id, usuario_id, usuarios(nombre)'),
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

  const ordenados = [...almacenes].sort((a, b) => nombreAlmacen(a).localeCompare(nombreAlmacen(b)));

  ordenados.forEach((a) => {
    const cantidad = cantidadPorAlmacen.get(a.id) || 0;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(nombreAlmacen(a))}</div>
      </div>
      <div class="li-badge ${cantidad > 0 ? 'al-dia' : 'pendiente'}">${cantidad}</div>
    `;
    list.appendChild(item);
  });
}

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
    const { error } = await supabase.rpc('registrar_entrada', {
      p_producto_id: productoEditId,
      p_cantidad: cantidad,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('PERMISO_DENEGADO')) {
        errorEl.textContent = 'Solo un administrador puede registrar/anular movimientos de almacén.';
      } else {
        errorEl.textContent = 'No se pudo registrar la entrada. Intenta de nuevo.';
      }
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

async function comprimirImagen(file, maxDim = 900, calidad = 0.82) {
  const bitmap = await createImageBitmap(file);
  const escala = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const ancho = Math.round(bitmap.width * escala);
  const alto = Math.round(bitmap.height * escala);

  const canvas = document.createElement('canvas');
  canvas.width = ancho;
  canvas.height = alto;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, ancho, alto);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', calidad);
  });
}

async function handleFotoChange(event) {
  const file = event.target.files && event.target.files[0];
  const preview = document.getElementById('producto-foto-preview');
  if (!file) return;

  try {
    productoFotoBlobComprimido = await comprimirImagen(file);
  } catch {
    productoFotoBlobComprimido = file;
  }

  preview.src = URL.createObjectURL(productoFotoBlobComprimido);
  preview.style.display = 'block';
}

async function saveProducto() {
  if (!assertOnline()) return;

  const nombre = document.getElementById('producto-nombre').value.trim();
  const precio = parseFloat(document.getElementById('producto-precio').value);
  const costo = parseFloat(document.getElementById('producto-costo').value);
  const stock = parseInt(document.getElementById('producto-stock').value, 10);
  const categoria = document.getElementById('producto-categoria').value.trim();
  const errorEl = document.getElementById('producto-form-error');
  const saveBtn = document.getElementById('producto-guardar');

  errorEl.textContent = '';

  if (!nombre) {
    errorEl.textContent = 'El nombre es obligatorio.';
    return;
  }
  if (!Number.isFinite(precio) || precio <= 0) {
    errorEl.textContent = 'El precio es obligatorio y debe ser mayor a $0.';
    return;
  }
  if (!Number.isFinite(costo) || costo <= 0) {
    errorEl.textContent = 'El costo es obligatorio y debe ser mayor a $0.';
    return;
  }
  if (!productoEditId && (!Number.isInteger(stock) || stock < 0)) {
    errorEl.textContent = 'El stock inicial es obligatorio y debe ser un número entero, 0 o mayor.';
    return;
  }
  if (!productoFotoBlobComprimido && !productoFotoUrlActual) {
    errorEl.textContent = 'La foto es obligatoria.';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

  try {
    let fotoUrl = productoFotoUrlActual;

    if (productoFotoBlobComprimido) {
      const path = `${crypto.randomUUID()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('productos')
        .upload(path, productoFotoBlobComprimido, { contentType: 'image/jpeg' });
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
      const { error } = await supabase.rpc('crear_producto', {
        p_nombre: nombre,
        p_precio: precio,
        p_costo: costo,
        p_foto_url: fotoUrl,
        p_categoria: categoria || null,
        p_stock_inicial: stock,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('PERMISO_DENEGADO')) {
          errorEl.textContent = 'Solo un administrador puede dar de alta productos con stock.';
        } else {
          errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
        }
        return;
      }
    }

    closeProductoForm();
    toast(productoEditId ? 'Producto actualizado.' : 'Producto agregado.');
    loadProductos();
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar';
  }
}

function initInventario() {
  document.getElementById('fab-nuevo-producto').addEventListener('click', () => openProductoForm());
  document.getElementById('producto-cancelar').addEventListener('click', closeProductoForm);
  document.getElementById('producto-guardar').addEventListener('click', saveProducto);
  document.getElementById('producto-foto').addEventListener('change', handleFotoChange);
  document.getElementById('producto-entrada-confirmar').addEventListener('click', registrarEntradaProducto);
}

// ---------- Recibos: PDF y WhatsApp ----------

async function capturarRecibo(contenedorEl) {
  return html2canvas(contenedorEl, { backgroundColor: '#ffffff', scale: 2 });
}

async function descargarReciboPDF(contenedorEl, folio, btn) {
  const textoOriginal = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generando...';
  }

  try {
    const canvas = await capturarRecibo(contenedorEl);
    const pdf = new jsPDF({
      orientation: canvas.width >= canvas.height ? 'l' : 'p',
      unit: 'px',
      format: [canvas.width, canvas.height],
    });
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
    pdf.save(`recibo-${folio}.pdf`);
  } catch (err) {
    toast('No se pudo generar el PDF. Intenta de nuevo.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }
}

async function compartirReciboWhatsApp(contenedorEl, folio, btn) {
  const textoOriginal = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Compartiendo...';
  }

  try {
    const canvas = await capturarRecibo(contenedorEl);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      toast('No se pudo compartir. Intenta de nuevo.', 'error');
      return;
    }
    const file = new File([blob], `recibo-${folio}.png`, { type: 'image/png' });

    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name === 'AbortError') return; // usuario canceló el picker — no es un error
      toast('No se pudo compartir. Intenta de nuevo.', 'error');
    }
  } catch (err) {
    toast('No se pudo compartir. Intenta de nuevo.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }
}

function soportaCompartirArchivos() {
  if (!navigator.canShare) return false;
  try {
    const testFile = new File([''], 'test.png', { type: 'image/png' });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

// ---------- Ventas ----------

const fechaFmt = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

let ventaCarrito = new Map(); // producto_id -> { producto, cantidad }
let ventaProductosCache = [];
let ventaTipo = 'contado';
let ventaReciboFolioActual = null;

function setVentaTipo(tipo) {
  ventaTipo = tipo;
  document.querySelectorAll('.toggle-btn[data-tipo]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tipo === tipo);
  });
  document.getElementById('venta-enganche-field').style.display = tipo === 'credito' ? 'block' : 'none';
  document.getElementById('venta-cliente-label').textContent =
    tipo === 'credito' ? 'Cliente (obligatorio)' : 'Cliente (opcional)';
}

async function openVentaPanel() {
  document.getElementById('venta-panel-titulo').textContent = 'Nueva venta';
  ventaCarrito = new Map();
  setVentaTipo('contado');
  document.getElementById('venta-enganche').value = '';
  document.getElementById('venta-error').textContent = '';
  document.getElementById('venta-paso-recibo').style.display = 'none';
  document.getElementById('venta-paso-armar').style.display = 'block';

  const session = getSession();
  const [{ data: productos, error: prodError }, { data: clientes, error: cliError }] = await Promise.all([
    supabase
      .from('productos')
      .select('id, nombre, precio, costo, stock_almacen!inner(cantidad)')
      .eq('stock_almacen.almacen_id', session.almacenId)
      .gt('stock_almacen.cantidad', 0)
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

  const clienteSelect = document.getElementById('venta-cliente');
  clienteSelect.innerHTML = '<option value="">Sin cliente</option>';
  (clientes || []).forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nombre;
    clienteSelect.appendChild(opt);
  });

  renderVentaProductos();
  renderVentaCarrito();

  document.getElementById('venta-panel').classList.add('show');
}

function closeVentaPanel() {
  document.getElementById('venta-panel').classList.remove('show');
}

function cantidadEnCarrito(productoId) {
  const entry = ventaCarrito.get(productoId);
  return entry ? entry.cantidad : 0;
}

function renderVentaProductos() {
  const list = document.getElementById('venta-productos-list');
  const empty = document.getElementById('venta-productos-empty');
  list.innerHTML = '';
  empty.style.display = ventaProductosCache.length === 0 ? 'block' : 'none';

  ventaProductosCache.forEach((p) => {
    const disponible = p.stock - cantidadEnCarrito(p.id);
    const item = document.createElement('div');
    item.className = 'list-item' + (disponible <= 0 ? ' disabled' : '');
    item.innerHTML = `
      <div class="li-main">
        <div class="li-title">${escapeHtml(p.nombre)}</div>
        <div class="li-sub">${money.format(Number(p.precio))} · Stock disponible: ${disponible}</div>
      </div>
    `;
    if (disponible > 0) {
      item.addEventListener('click', () => addToCarrito(p));
    }
    list.appendChild(item);
  });
}

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

function decrementarCarrito(productoId) {
  const entry = ventaCarrito.get(productoId);
  if (!entry) return;
  if (entry.cantidad <= 1) {
    ventaCarrito.delete(productoId);
  } else {
    entry.cantidad -= 1;
  }
  renderVentaProductos();
  renderVentaCarrito();
}

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

async function confirmarVenta() {
  if (!assertOnline()) return;

  const errorEl = document.getElementById('venta-error');
  const confirmBtn = document.getElementById('venta-confirmar');
  errorEl.textContent = '';

  if (ventaCarrito.size === 0) {
    errorEl.textContent = 'Agrega al menos un producto al carrito.';
    return;
  }

  const session = getSession();
  const clienteId = document.getElementById('venta-cliente').value || null;
  const clienteNombre = clienteId
    ? document.getElementById('venta-cliente').selectedOptions[0].textContent
    : null;

  if (ventaTipo === 'credito' && !clienteId) {
    errorEl.textContent = 'La venta a crédito requiere un cliente.';
    return;
  }

  const totalCarrito = calcularTotalCarrito();

  let enganche = 0;
  if (ventaTipo === 'credito') {
    const rawEnganche = document.getElementById('venta-enganche').value;
    enganche = rawEnganche === '' ? 0 : parseFloat(rawEnganche);
    if (!Number.isFinite(enganche) || enganche < 0 || enganche > totalCarrito) {
      errorEl.textContent = 'El enganche debe ser entre $0 y el total de la venta.';
      return;
    }
  }

  const items = [...ventaCarrito.values()].map(({ producto, cantidad, precioUnitario }) => ({
    producto_id: producto.id,
    cantidad,
    precio_unitario: precioUnitario,
  }));
  const itemsParaRecibo = [...ventaCarrito.values()];

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Registrando...';

  try {
    const { data, error } = await supabase.rpc('registrar_venta', {
      p_tipo: ventaTipo,
      p_cliente_id: clienteId,
      p_enganche: enganche,
      p_items: items,
    });

    if (error) {
      if ((error.message || '').includes('STOCK_INSUFICIENTE')) {
        errorEl.textContent = 'Uno de los productos ya no tiene stock suficiente. Actualiza el carrito.';
      } else {
        errorEl.textContent = 'No se pudo registrar la venta. Intenta de nuevo.';
      }
      return;
    }

    const resultado = data[0];
    let saldoResultante = null;

    if (ventaTipo === 'credito') {
      const { data: clienteData } = await supabase
        .from('clientes')
        .select('saldo_pendiente')
        .eq('id', clienteId)
        .single();
      saldoResultante = clienteData ? Number(clienteData.saldo_pendiente) : null;
    }

    mostrarReciboVenta({
      folio: resultado.folio,
      total: Number(resultado.total),
      tipo: ventaTipo,
      enganche,
      saldoResultante,
      cliente: clienteNombre,
      vendedor: session.nombre,
      fecha: new Date(),
      items: itemsParaRecibo,
    });

    loadProductos();
    loadClientes();
    loadDashboard();
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirmar venta';
  }
}

function mostrarReciboVenta(info) {
  const cont = document.getElementById('venta-recibo-contenido');
  ventaReciboFolioActual = info.folio;
  const lineasProductos = info.items
    .map(({ producto, cantidad, precioUnitario }) => `
      <div class="recibo-linea">
        <span>${cantidad} × ${escapeHtml(producto.nombre)}</span>
        <span>${money.format(precioUnitario * cantidad)}</span>
      </div>
    `)
    .join('');

  const lineasCredito = info.tipo === 'credito'
    ? `
      <div class="recibo-linea"><span>Enganche</span><span>${money.format(info.enganche)}</span></div>
      <div class="recibo-linea"><span>Saldo pendiente del cliente</span><span>${money.format(info.saldoResultante ?? 0)}</span></div>
    `
    : '';

  cont.innerHTML = `
    <div class="recibo-linea"><span>Folio</span><span>${escapeHtml(info.folio)}</span></div>
    <div class="recibo-linea"><span>Fecha</span><span>${fechaFmt.format(info.fecha)}</span></div>
    <div class="recibo-linea"><span>Vendedor</span><span>${escapeHtml(info.vendedor)}</span></div>
    <div class="recibo-linea"><span>Cliente</span><span>${info.cliente ? escapeHtml(info.cliente) : 'Sin cliente'}</span></div>
    <div class="recibo-linea"><span>Tipo</span><span>${info.tipo === 'credito' ? 'Crédito' : 'Contado'}</span></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">
    ${lineasProductos}
    <div class="recibo-linea total"><span>Total</span><span>${money.format(info.total)}</span></div>
    ${lineasCredito}
  `;

  document.getElementById('venta-paso-armar').style.display = 'none';
  document.getElementById('venta-paso-recibo').style.display = 'block';
  document.getElementById('venta-recibo-whatsapp').style.display = soportaCompartirArchivos() ? 'block' : 'none';
}

function initVentas() {
  document.getElementById('btn-nueva-venta').addEventListener('click', openVentaPanel);
  document.getElementById('venta-cerrar').addEventListener('click', closeVentaPanel);
  document.getElementById('venta-confirmar').addEventListener('click', confirmarVenta);
  document.getElementById('venta-recibo-cerrar').addEventListener('click', closeVentaPanel);
  document.getElementById('venta-recibo-pdf').addEventListener('click', (e) => {
    descargarReciboPDF(document.getElementById('venta-recibo-contenido'), ventaReciboFolioActual, e.currentTarget);
  });
  document.getElementById('venta-recibo-whatsapp').addEventListener('click', (e) => {
    compartirReciboWhatsApp(document.getElementById('venta-recibo-contenido'), ventaReciboFolioActual, e.currentTarget);
  });
  document.querySelectorAll('.toggle-btn[data-tipo]').forEach((btn) => {
    btn.addEventListener('click', () => setVentaTipo(btn.dataset.tipo));
  });
}

// ---------- Abonos ----------

let abonoClientesCache = [];
let abonoReciboFolioActual = null;

async function openAbonoPanel() {
  document.getElementById('abono-panel-titulo').textContent = 'Nuevo abono';
  document.getElementById('abono-error').textContent = '';
  document.getElementById('abono-monto').value = '';
  document.getElementById('abono-saldo-actual').style.display = 'none';
  document.getElementById('abono-paso-recibo').style.display = 'none';
  document.getElementById('abono-paso-armar').style.display = 'block';

  const { data, error } = await supabase
    .from('clientes')
    .select('id, nombre, saldo_pendiente')
    .gt('saldo_pendiente', 0)
    .order('nombre');

  if (error) {
    toast('No se pudo cargar la lista de clientes.', 'error');
    return;
  }

  abonoClientesCache = data || [];

  const select = document.getElementById('abono-cliente');
  select.innerHTML = '<option value="">Selecciona un cliente con saldo pendiente</option>';
  abonoClientesCache.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.nombre} — ${money.format(Number(c.saldo_pendiente))}`;
    select.appendChild(opt);
  });

  document.getElementById('abono-panel').classList.add('show');
}

function closeAbonoPanel() {
  document.getElementById('abono-panel').classList.remove('show');
}

function handleAbonoClienteChange() {
  const clienteId = document.getElementById('abono-cliente').value;
  const cliente = abonoClientesCache.find((c) => c.id === clienteId);
  const saldoEl = document.getElementById('abono-saldo-actual');

  if (cliente) {
    saldoEl.textContent = `Saldo pendiente actual: ${money.format(Number(cliente.saldo_pendiente))}`;
    saldoEl.style.display = 'block';
    document.getElementById('abono-monto').max = cliente.saldo_pendiente;
  } else {
    saldoEl.style.display = 'none';
  }
}

async function confirmarAbono() {
  if (!assertOnline()) return;

  const errorEl = document.getElementById('abono-error');
  const confirmBtn = document.getElementById('abono-confirmar');
  errorEl.textContent = '';

  const clienteId = document.getElementById('abono-cliente').value;
  const cliente = abonoClientesCache.find((c) => c.id === clienteId);
  const monto = parseFloat(document.getElementById('abono-monto').value);

  if (!clienteId) {
    errorEl.textContent = 'Selecciona un cliente.';
    return;
  }
  if (!Number.isFinite(monto) || monto <= 0) {
    errorEl.textContent = 'El monto debe ser mayor a $0.';
    return;
  }
  if (cliente && monto > Number(cliente.saldo_pendiente)) {
    errorEl.textContent = `El monto no puede ser mayor al saldo pendiente (${money.format(Number(cliente.saldo_pendiente))}).`;
    return;
  }

  const session = getSession();
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Registrando...';

  try {
    const { data, error } = await supabase.rpc('registrar_abono', {
      p_cliente_id: clienteId,
      p_monto: monto,
    });

    if (error) {
      if ((error.message || '').includes('MONTO_MAYOR_A_SALDO')) {
        errorEl.textContent = 'El monto no puede ser mayor al saldo pendiente del cliente.';
      } else {
        errorEl.textContent = 'No se pudo registrar el abono. Intenta de nuevo.';
      }
      return;
    }

    const resultado = data[0];
    mostrarReciboAbono({
      folio: resultado.folio,
      monto,
      saldoRestante: Number(resultado.saldo_restante),
      cliente: cliente ? cliente.nombre : '',
      vendedor: session.nombre,
      fecha: new Date(),
    });

    loadClientes();
    loadDashboard();
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirmar abono';
  }
}

function mostrarReciboAbono(info) {
  const cont = document.getElementById('abono-recibo-contenido');
  abonoReciboFolioActual = info.folio;
  cont.innerHTML = `
    <div class="recibo-linea"><span>Folio</span><span>${escapeHtml(info.folio)}</span></div>
    <div class="recibo-linea"><span>Fecha</span><span>${fechaFmt.format(info.fecha)}</span></div>
    <div class="recibo-linea"><span>Vendedor</span><span>${escapeHtml(info.vendedor)}</span></div>
    <div class="recibo-linea"><span>Cliente</span><span>${escapeHtml(info.cliente)}</span></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">
    <div class="recibo-linea total"><span>Monto abonado</span><span>${money.format(info.monto)}</span></div>
    <div class="recibo-linea"><span>Saldo pendiente restante</span><span>${info.saldoRestante === null ? 'No disponible' : money.format(info.saldoRestante)}</span></div>
  `;

  document.getElementById('abono-paso-armar').style.display = 'none';
  document.getElementById('abono-paso-recibo').style.display = 'block';
  document.getElementById('abono-recibo-whatsapp').style.display = soportaCompartirArchivos() ? 'block' : 'none';
}

function initAbonos() {
  document.getElementById('btn-nuevo-abono').addEventListener('click', openAbonoPanel);
  document.getElementById('abono-cerrar').addEventListener('click', closeAbonoPanel);
  document.getElementById('abono-cliente').addEventListener('change', handleAbonoClienteChange);
  document.getElementById('abono-confirmar').addEventListener('click', confirmarAbono);
  document.getElementById('abono-recibo-cerrar').addEventListener('click', closeAbonoPanel);
  document.getElementById('abono-recibo-pdf').addEventListener('click', (e) => {
    descargarReciboPDF(document.getElementById('abono-recibo-contenido'), abonoReciboFolioActual, e.currentTarget);
  });
  document.getElementById('abono-recibo-whatsapp').addEventListener('click', (e) => {
    compartirReciboWhatsApp(document.getElementById('abono-recibo-contenido'), abonoReciboFolioActual, e.currentTarget);
  });
}

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
    historialCache = [];
    renderHistorial();
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
      const btnAnular = card.querySelector('.btn-anular');
      btnAnular.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmarAnular(item, btnAnular);
      });
    }

    card.addEventListener('click', () => verReciboHistorial(item));
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

// Reconstruye y muestra el recibo de una venta o abono ya registrado, reutilizando
// el mismo paso de recibo (con PDF/WhatsApp) de los paneles de venta/abono.
async function verReciboHistorial(item) {
  if (item.tipo === 'venta') {
    const { data, error } = await supabase
      .from('ventas')
      .select(`
        folio, tipo, total, enganche, creado_en, saldo_pendiente_venta,
        cliente:clientes(nombre),
        vendedor:usuarios!ventas_vendedor_id_fkey(nombre),
        venta_items(cantidad, precio_unitario, producto:productos(nombre))
      `)
      .eq('id', item.id)
      .single();

    if (error || !data) {
      toast('No se pudo cargar el recibo.', 'error');
      return;
    }

    mostrarReciboVenta({
      folio: data.folio,
      total: Number(data.total),
      tipo: data.tipo,
      enganche: Number(data.enganche),
      saldoResultante: data.tipo === 'credito' ? Number(data.saldo_pendiente_venta) : null,
      cliente: data.cliente ? data.cliente.nombre : null,
      vendedor: data.vendedor ? data.vendedor.nombre : '—',
      fecha: new Date(data.creado_en),
      items: (data.venta_items || []).map((it) => ({
        producto: { nombre: it.producto ? it.producto.nombre : '—' },
        cantidad: it.cantidad,
        precioUnitario: Number(it.precio_unitario),
      })),
    });
    document.getElementById('venta-panel-titulo').textContent = 'Recibo de venta';
    document.getElementById('venta-panel').classList.add('show');
  } else {
    const { data, error } = await supabase
      .from('abonos')
      .select(`
        folio, monto, creado_en, saldo_restante,
        cliente:clientes(nombre),
        vendedor:usuarios!abonos_vendedor_id_fkey(nombre)
      `)
      .eq('id', item.id)
      .single();

    if (error || !data) {
      toast('No se pudo cargar el recibo.', 'error');
      return;
    }

    mostrarReciboAbono({
      folio: data.folio,
      monto: Number(data.monto),
      // Snapshot guardado al momento del abono (registrar_abono) — copia fiel de la
      // transacción, no el saldo actual del cliente (que puede haber cambiado desde).
      saldoRestante: data.saldo_restante !== null ? Number(data.saldo_restante) : null,
      cliente: data.cliente ? data.cliente.nombre : '',
      vendedor: data.vendedor ? data.vendedor.nombre : '—',
      fecha: new Date(data.creado_en),
    });
    document.getElementById('abono-panel-titulo').textContent = 'Recibo de abono';
    document.getElementById('abono-panel').classList.add('show');
  }
}

async function confirmarAnular(item, btn) {
  if (!assertOnline()) return;

  const tipoLabel = item.tipo === 'venta' ? 'venta' : 'abono';
  const ok = window.confirm(
    `¿Seguro que quieres anular esta ${tipoLabel} de ${money.format(item.monto)} (folio ${item.folio})? No se puede deshacer.`
  );
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Anulando...';

  try {
    const rpcName = item.tipo === 'venta' ? 'anular_venta' : 'anular_abono';
    const params = item.tipo === 'venta'
      ? { p_venta_id: item.id }
      : { p_abono_id: item.id };

    const { error } = await supabase.rpc(rpcName, params);

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

    toast('Registro anulado.');
    loadHistorial();
    loadProductos();
    loadClientes();
    loadDashboard();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anular';
  }
}

function initHistorial() {
  document.getElementById('btn-historial').addEventListener('click', openHistorialPanel);
  document.getElementById('historial-cerrar').addEventListener('click', closeHistorialPanel);
}

// ---------- Reportes ----------

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
    { data: vendedoresConsigna, error: consignaError },
    { data: todosVendedores, error: vendedoresError },
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
    supabase.from('usuarios')
      .select('id, nombre, deuda_consigna')
      .eq('rol', 'vendedor').gt('deuda_consigna', 0)
      .order('deuda_consigna', { ascending: false }),
    // Nunca hardcodear nombres aquí — se lee siempre de usuarios. Incluye admin (un
    // admin puede vender, ticket 12) e inactivos (para no perder su historial en
    // reportes de meses anteriores a su baja).
    supabase.from('usuarios')
      .select('nombre')
      .order('nombre'),
  ]);

  if (ventasError || abonosError || clientesError || pagosError || itemsError || consignaError || vendedoresError) {
    toast('No se pudo cargar Reportes.', 'error');
    return;
  }

  renderReportesTotales(ventasPeriodo || [], pagosPeriodo || []);
  renderReportesSaldos(clientesSaldo || []);
  renderReportesConsigna(vendedoresConsigna || []);
  renderReportesVendedores((todosVendedores || []).map((v) => v.nombre), ventasPeriodo || [], abonosPeriodo || [], pagosPeriodo || []);
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

function renderReportesConsigna(vendedores) {
  const total = vendedores.reduce((sum, v) => sum + Number(v.deuda_consigna), 0);
  document.getElementById('rep-consigna-total').textContent = money.format(total);

  const list = document.getElementById('rep-consigna-list');
  const empty = document.getElementById('rep-consigna-empty');
  list.innerHTML = '';
  empty.style.display = vendedores.length === 0 ? 'block' : 'none';

  vendedores.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main"><div class="li-title">${escapeHtml(v.nombre)}</div></div>
      <div class="li-badge pendiente">${money.format(Number(v.deuda_consigna))}</div>
    `;
    list.appendChild(item);
  });
}

function renderReportesVendedores(nombresVendedores, ventas, abonos, pagos) {
  const tbody = document.getElementById('rep-vendedores-tbody');
  tbody.innerHTML = '';

  nombresVendedores.forEach((nombre) => {
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

  const seccionUsuarios = document.getElementById('cuenta-usuarios-seccion');
  if (session.rol === 'admin') {
    seccionUsuarios.style.display = 'block';
    loadUsuarios();
  } else {
    seccionUsuarios.style.display = 'none';
  }

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
    // Ticket 17: la contraseña real vive en Supabase Auth desde la Fase B — se
    // reautentica con la actual para confirmarla (mismo requisito de siempre) y
    // luego se cambia con auth.updateUser(). Ya no se toca `usuarios.password_hash`
    // (columna en desuso, pendiente de retirar en limpieza futura).
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: correoSintetico(session.nombre),
      password: actual,
    });

    if (reauthError) {
      errorEl.textContent = 'La contraseña actual no es correcta.';
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: nueva });

    if (error) {
      errorEl.textContent = 'No se pudo cambiar la contraseña. Intenta de nuevo.';
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

  // Ticket 17 (Fase C, pendiente Fase D): dar de alta un usuario nuevo o resetear la
  // contraseña de otro requiere crear/editar su cuenta de Supabase Auth, y eso exige la
  // clave service_role — solo se puede hacer desde una Edge Function (Fase D, no
  // desplegada todavía). Se bloquea aquí con un mensaje claro en vez de dejar que
  // parezca que funcionó sin tener ningún efecto real (ver docs/superpowers/specs/
  // 2026-08-03-auth-real-rls-design.md sección 6).
  if (!usuarioEditId) {
    errorEl.textContent =
      'Alta de usuarios nuevos no disponible todavía (pendiente ticket 17, fase D). ' +
      'Pídele a Claude que la complete.';
    return;
  }
  if (password) {
    errorEl.textContent =
      'Resetear la contraseña de otro usuario no está disponible todavía (pendiente ' +
      'ticket 17, fase D) — pídele que la cambie él mismo desde "Mi cuenta", o pídele a ' +
      'Claude que complete esa fase.';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

  try {
    const { error: updateError } = await supabase.rpc('actualizar_datos_usuario', {
      p_usuario_id: usuarioEditId,
      p_nombre: nombre,
      p_rol: rol,
    });

    if (updateError) {
      if (updateError.code === '23505') {
        errorEl.textContent = 'Ya existe un usuario con ese nombre.';
      } else {
        const msg = updateError.message || '';
        if (msg.includes('ULTIMO_ADMIN')) {
          errorEl.textContent =
            'No puedes quitarle el rol de admin al único admin activo — activa a otro admin primero.';
        } else if (msg.includes('PERMISO_DENEGADO')) {
          errorEl.textContent = 'No tienes permiso para hacer esto.';
        } else {
          errorEl.textContent = 'No se pudo guardar. Intenta de nuevo.';
        }
      }
      return;
    }

    const activoBtn = document.querySelector('#usuario-activo-toggle .toggle-btn.active');
    const activoNuevo = activoBtn.dataset.activo === 'true';
    const { error: estatusError } = await supabase.rpc('cambiar_estatus_usuario', {
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
    closeUsuarioForm();
    loadUsuarios();
    cargarLoginCategorias();
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar';
  }
}

// ---------- Movimientos ----------

let movimientosCache = [];
let almacenesCache = [];
let productosParaMovimientoCache = [];
let vendedoresParaConsignaCache = [];
let movimientoReciboFolioActual = null;

async function loadAlmacenes() {
  const { data, error } = await supabase
    .from('almacenes')
    .select('id, usuario_id, usuarios(nombre)');
  almacenesCache = (error ? [] : (data || [])).sort((a, b) => nombreAlmacen(a).localeCompare(nombreAlmacen(b)));
}

async function loadMovimientos() {
  const [{ data: movs, error: movsError }, { data: pagos, error: pagosError }] = await Promise.all([
    supabase
      .from('movimientos_almacen')
      .select(`
        id, cantidad, creado_en, anulado, anulado_en,
        producto:productos(nombre),
        origen:almacenes!movimientos_almacen_almacen_origen_id_fkey(usuario_id, usuarios(nombre)),
        destino:almacenes!movimientos_almacen_almacen_destino_id_fkey(usuario_id, usuarios(nombre)),
        usuario:usuarios!movimientos_almacen_usuario_id_fkey(nombre),
        anulador:usuarios!movimientos_almacen_anulado_por_fkey(nombre)
      `)
      .order('creado_en', { ascending: false })
      .limit(200),
    supabase
      .from('pagos_consigna')
      .select(`
        id, monto, deuda_restante, creado_en, anulado, anulado_en,
        vendedor:usuarios!pagos_consigna_vendedor_id_fkey(nombre),
        usuario:usuarios!pagos_consigna_usuario_id_fkey(nombre),
        anulador:usuarios!pagos_consigna_anulado_por_fkey(nombre)
      `)
      .order('creado_en', { ascending: false })
      .limit(200),
  ]);

  if (movsError || pagosError) {
    toast('No se pudo cargar los movimientos.', 'error');
    movimientosCache = [];
    renderMovimientos();
    return;
  }

  const itemsMov = (movs || []).map((m) => ({ kind: 'movimiento', creadoEn: new Date(m.creado_en), data: m }));
  const itemsPago = (pagos || []).map((p) => ({ kind: 'pago_consigna', creadoEn: new Date(p.creado_en), data: p }));

  movimientosCache = [...itemsMov, ...itemsPago].sort((a, b) => b.creadoEn - a.creadoEn);
  renderMovimientos();
}

let deudaConsignaCache = [];

async function loadDeudaConsigna() {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nombre, deuda_consigna')
    .eq('rol', 'vendedor')
    .order('nombre');

  if (error) {
    deudaConsignaCache = [];
    renderDeudaConsigna();
    return;
  }

  deudaConsignaCache = data || [];
  renderDeudaConsigna();
}

function renderDeudaConsigna() {
  const list = document.getElementById('consigna-deuda-list');
  const empty = document.getElementById('consigna-deuda-empty');
  list.innerHTML = '';
  empty.style.display = deudaConsignaCache.length === 0 ? 'block' : 'none';

  deudaConsignaCache.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="li-main"><div class="li-title">${escapeHtml(v.nombre)}</div></div>
      <div class="li-badge ${Number(v.deuda_consigna) > 0 ? 'pendiente' : 'al-dia'}">${money.format(Number(v.deuda_consigna))}</div>
    `;
    list.appendChild(item);
  });
}

function renderMovimientos() {
  const list = document.getElementById('movimientos-list');
  const empty = document.getElementById('movimientos-empty');
  const session = getSession();

  list.innerHTML = '';
  empty.style.display = movimientosCache.length === 0 ? 'block' : 'none';

  movimientosCache.forEach((item) => {
    const card = document.createElement('div');

    if (item.kind === 'pago_consigna') {
      const p = item.data;
      const anuladoTag = p.anulado
        ? '<div class="li-sub historial-anulado-tag">Anulado</div>'
        : '';

      card.className = 'list-item historial-item' + (p.anulado ? ' anulado' : '');
      card.innerHTML = `
        <div class="li-main">
          <div class="li-title">Pago de consigna: ${escapeHtml(p.vendedor.nombre)} · ${money.format(Number(p.monto))}</div>
          <div class="li-sub">${escapeHtml(p.usuario.nombre)} · ${fechaFmt.format(new Date(p.creado_en))}</div>
          ${anuladoTag}
        </div>
        <div class="historial-item-right">
          ${session && session.rol === 'admin' && !p.anulado ? '<button type="button" class="btn-anular">Anular</button>' : ''}
        </div>
      `;

      if (session && session.rol === 'admin' && !p.anulado) {
        card.querySelector('.btn-anular').addEventListener('click', (e) => {
          confirmarAnularPagoConsigna(p.id, e.currentTarget);
        });
      }

      list.appendChild(card);
      return;
    }

    const m = item.data;
    const descripcion = m.origen
      ? `Traspaso: ${escapeHtml(nombreAlmacen(m.origen))} → ${escapeHtml(nombreAlmacen(m.destino))}`
      : `Entrada → ${escapeHtml(nombreAlmacen(m.destino))}`;

    const anuladoTag = m.anulado
      ? '<div class="li-sub historial-anulado-tag">Anulado</div>'
      : '';

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
    const { error } = await supabase.rpc('anular_movimiento', {
      p_movimiento_id: movimientoId,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('STOCK_INSUFICIENTE_PARA_ANULAR')) {
        toast('No se puede anular: esas unidades ya se movieron o vendieron desde entonces.', 'error');
      } else if (msg.includes('YA_ANULADO')) {
        toast('Este movimiento ya estaba anulado.', 'error');
      } else if (msg.includes('PERMISO_DENEGADO')) {
        toast('Solo un administrador puede registrar/anular movimientos de almacén.', 'error');
      } else {
        toast('No se pudo anular. Intenta de nuevo.', 'error');
      }
      return;
    }

    toast('Movimiento anulado.');
    loadMovimientos();
    loadDeudaConsigna();
    loadProductos();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anular';
  }
}

async function confirmarAnularPagoConsigna(pagoId, btn) {
  if (!assertOnline()) return;

  const ok = window.confirm('¿Seguro que quieres anular este pago de consigna? No se puede deshacer.');
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Anulando...';

  try {
    const { error } = await supabase.rpc('anular_pago_consigna', {
      p_pago_id: pagoId,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('YA_ANULADO')) {
        toast('Ese pago ya estaba anulado.', 'error');
      } else if (msg.includes('PERMISO_DENEGADO')) {
        toast('Solo un administrador puede registrar/anular pagos de consigna.', 'error');
      } else {
        toast('No se pudo anular. Intenta de nuevo.', 'error');
      }
      return;
    }

    toast('Pago de consigna anulado.');
    loadMovimientos();
    loadDeudaConsigna();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anular';
  }
}

async function openMovimientosPanel() {
  const session = getSession();
  document.getElementById('fab-nuevo-movimiento').classList.toggle('show', session.rol === 'admin');
  document.getElementById('movimientos-panel').classList.add('show');
  await Promise.all([loadMovimientos(), loadDeudaConsigna()]);
}

function closeMovimientosPanel() {
  document.getElementById('movimientos-panel').classList.remove('show');
}

async function openMovimientoForm() {
  document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tipo === 'entrada');
  });
  document.getElementById('movimiento-origen-row').style.display = 'none';
  document.getElementById('movimiento-destino-row').style.display = 'none';
  document.getElementById('movimiento-producto-row').style.display = 'block';
  document.getElementById('movimiento-cantidad-row').style.display = 'block';
  document.getElementById('movimiento-vendedor-row').style.display = 'none';
  document.getElementById('movimiento-monto-row').style.display = 'none';
  document.getElementById('movimiento-cantidad').value = '';
  document.getElementById('movimiento-monto').value = '';
  document.getElementById('movimiento-form-error').textContent = '';
  document.getElementById('movimiento-paso-armar').style.display = 'block';
  document.getElementById('movimiento-paso-recibo').style.display = 'none';

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
      opt.textContent = nombreAlmacen(a);
      select.appendChild(opt);
    });
  });

  const { data: vendedores } = await supabase
    .from('usuarios')
    .select('id, nombre')
    .eq('rol', 'vendedor')
    .eq('activo', true)
    .order('nombre');
  vendedoresParaConsignaCache = vendedores || [];

  const vendedorSelect = document.getElementById('movimiento-vendedor');
  vendedorSelect.innerHTML = '';
  vendedoresParaConsignaCache.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.nombre;
    vendedorSelect.appendChild(opt);
  });

  document.getElementById('movimiento-sheet').classList.add('show');
}

function closeMovimientoForm() {
  document.getElementById('movimiento-sheet').classList.remove('show');
}

async function guardarMovimiento() {
  if (!assertOnline()) return;

  const tipo = document.querySelector('#movimiento-tipo-toggle .toggle-btn.active').dataset.tipo;
  const errorEl = document.getElementById('movimiento-form-error');
  const btn = document.getElementById('movimiento-guardar');

  errorEl.textContent = '';

  if (tipo === 'pago_consigna') {
    const vendedorId = document.getElementById('movimiento-vendedor').value;
    const monto = parseFloat(document.getElementById('movimiento-monto').value);
    const vendedor = vendedoresParaConsignaCache.find((v) => v.id === vendedorId);

    if (!vendedorId) {
      errorEl.textContent = 'Selecciona un vendedor.';
      return;
    }
    if (!Number.isFinite(monto) || monto <= 0) {
      errorEl.textContent = 'El monto debe ser mayor a $0.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const session = getSession();
      const { data, error } = await supabase.rpc('registrar_pago_consigna', {
        p_vendedor_id: vendedorId,
        p_monto: monto,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('MONTO_EXCEDE_DEUDA')) {
          errorEl.textContent = 'Ese pago es mayor a la deuda de consigna actual del vendedor.';
        } else if (msg.includes('PERMISO_DENEGADO')) {
          errorEl.textContent = 'Solo un administrador puede registrar/anular pagos de consigna.';
        } else {
          errorEl.textContent = 'No se pudo registrar el pago. Intenta de nuevo.';
        }
        return;
      }

      const resultado = data[0];
      mostrarReciboPagoConsigna({
        folio: resultado.folio,
        monto,
        deudaRestante: Number(resultado.deuda_restante),
        vendedor: vendedor ? vendedor.nombre : '',
        registradoPor: session.nombre,
        fecha: new Date(),
      });

      loadMovimientos();
      loadDeudaConsigna();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
    return;
  }

  const productoId = document.getElementById('movimiento-producto').value;
  const cantidad = parseInt(document.getElementById('movimiento-cantidad').value, 10);

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
    if (tipo === 'entrada') {
      const { error } = await supabase.rpc('registrar_entrada', {
        p_producto_id: productoId,
        p_cantidad: cantidad,
      });

      if (error) {
        const msg = error.message || '';
        if (msg.includes('PERMISO_DENEGADO')) {
          errorEl.textContent = 'Solo un administrador puede registrar/anular movimientos de almacén.';
        } else {
          errorEl.textContent = 'No se pudo registrar la entrada. Intenta de nuevo.';
        }
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
    loadDeudaConsigna();
    loadProductos();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}

function mostrarReciboPagoConsigna(info) {
  const cont = document.getElementById('movimiento-recibo-contenido');
  movimientoReciboFolioActual = info.folio;
  cont.innerHTML = `
    <div class="recibo-linea"><span>Folio</span><span>${escapeHtml(info.folio)}</span></div>
    <div class="recibo-linea"><span>Fecha</span><span>${fechaFmt.format(info.fecha)}</span></div>
    <div class="recibo-linea"><span>Registrado por</span><span>${escapeHtml(info.registradoPor)}</span></div>
    <div class="recibo-linea"><span>Vendedor</span><span>${escapeHtml(info.vendedor)}</span></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">
    <div class="recibo-linea total"><span>Monto pagado</span><span>${money.format(info.monto)}</span></div>
    <div class="recibo-linea"><span>Deuda de consigna restante</span><span>${money.format(info.deudaRestante)}</span></div>
  `;

  document.getElementById('movimiento-paso-armar').style.display = 'none';
  document.getElementById('movimiento-paso-recibo').style.display = 'block';
  document.getElementById('movimiento-recibo-whatsapp').style.display = soportaCompartirArchivos() ? 'block' : 'none';
}

function initMovimientos() {
  document.getElementById('btn-movimientos').addEventListener('click', openMovimientosPanel);
  document.getElementById('movimientos-cerrar').addEventListener('click', closeMovimientosPanel);
  document.getElementById('fab-nuevo-movimiento').addEventListener('click', openMovimientoForm);
  document.getElementById('movimiento-cancelar').addEventListener('click', closeMovimientoForm);
  document.getElementById('movimiento-guardar').addEventListener('click', guardarMovimiento);
  document.getElementById('movimiento-recibo-cerrar').addEventListener('click', closeMovimientoForm);
  document.getElementById('movimiento-recibo-pdf').addEventListener('click', (e) => {
    descargarReciboPDF(document.getElementById('movimiento-recibo-contenido'), movimientoReciboFolioActual, e.currentTarget);
  });
  document.getElementById('movimiento-recibo-whatsapp').addEventListener('click', (e) => {
    compartirReciboWhatsApp(document.getElementById('movimiento-recibo-contenido'), movimientoReciboFolioActual, e.currentTarget);
  });

  document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#movimiento-tipo-toggle .toggle-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const tipo = btn.dataset.tipo;
      const esTraspaso = tipo === 'traspaso';
      const esPagoConsigna = tipo === 'pago_consigna';

      document.getElementById('movimiento-origen-row').style.display = esTraspaso ? 'block' : 'none';
      document.getElementById('movimiento-destino-row').style.display = esTraspaso ? 'block' : 'none';
      document.getElementById('movimiento-producto-row').style.display = esPagoConsigna ? 'none' : 'block';
      document.getElementById('movimiento-cantidad-row').style.display = esPagoConsigna ? 'none' : 'block';
      document.getElementById('movimiento-vendedor-row').style.display = esPagoConsigna ? 'block' : 'none';
      document.getElementById('movimiento-monto-row').style.display = esPagoConsigna ? 'block' : 'none';
    });
  });
}

// ---------- Init ----------

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
