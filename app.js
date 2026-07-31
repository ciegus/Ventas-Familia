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

async function handleLogin(event) {
  event.preventDefault();
  if (!assertOnline()) return;

  const nombre = document.getElementById('login-nombre').value;
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
    renderMain(user);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Entrar';
  }
}

function handleLogout() {
  clearSession();
  historialCache = [];
  populateLoginUsuarios();
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

function handleFotoChange(event) {
  const file = event.target.files && event.target.files[0];
  const preview = document.getElementById('producto-foto-preview');
  if (!file) return;
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
}

async function saveProducto() {
  if (!assertOnline()) return;

  const nombre = document.getElementById('producto-nombre').value.trim();
  const precio = parseFloat(document.getElementById('producto-precio').value);
  const costo = parseFloat(document.getElementById('producto-costo').value);
  const stock = parseInt(document.getElementById('producto-stock').value, 10);
  const categoria = document.getElementById('producto-categoria').value.trim();
  const fileInput = document.getElementById('producto-foto');
  const file = fileInput.files && fileInput.files[0];
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
  if (!file && !productoFotoUrlActual) {
    errorEl.textContent = 'La foto es obligatoria.';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando...';

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
  ventaCarrito = new Map();
  setVentaTipo('contado');
  document.getElementById('venta-enganche').value = '';
  document.getElementById('venta-error').textContent = '';
  document.getElementById('venta-paso-recibo').style.display = 'none';
  document.getElementById('venta-paso-armar').style.display = 'block';

  const [{ data: productos, error: prodError }, { data: clientes, error: cliError }] = await Promise.all([
    supabase.from('productos').select('id, nombre, precio, stock, costo').order('nombre'),
    supabase.from('clientes').select('id, nombre').order('nombre'),
  ]);

  if (prodError || cliError) {
    toast('No se pudo cargar productos/clientes.', 'error');
    return;
  }

  ventaProductosCache = productos || [];

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
      p_vendedor_id: session.id,
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
      p_vendedor_id: session.id,
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
    <div class="recibo-linea"><span>Saldo pendiente restante</span><span>${money.format(info.saldoRestante)}</span></div>
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
      btnAnular.addEventListener('click', () => confirmarAnular(item, btnAnular));
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

const VENDEDORES_FIJOS = ['Papá', 'Angie', 'Alexa', 'Alexis'];
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
  ]);

  if (ventasError || abonosError || clientesError || pagosError || itemsError) {
    toast('No se pudo cargar Reportes.', 'error');
    return;
  }

  renderReportesTotales(ventasPeriodo || [], pagosPeriodo || []);
  renderReportesSaldos(clientesSaldo || []);
  renderReportesVendedores(ventasPeriodo || [], abonosPeriodo || [], pagosPeriodo || []);
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

function renderReportesVendedores(ventas, abonos, pagos) {
  const tbody = document.getElementById('rep-vendedores-tbody');
  tbody.innerHTML = '';

  VENDEDORES_FIJOS.forEach((nombre) => {
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
      const { error: updateError } = await supabase.rpc('actualizar_datos_usuario', {
        p_admin_id: session.id,
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

// ---------- Init ----------

function init() {
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  initNav();
  initClientes();
  initInventario();
  initVentas();
  initAbonos();
  initHistorial();
  initReportes();
  initCuenta();

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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
