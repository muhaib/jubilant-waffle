const user = Auth.requireRole(['owner', 'manager', 'cashier', 'waiter', 'kitchen']);

const ROLE_VIEWS = {
  owner: ['pos', 'orders', 'kitchen', 'tables', 'menu', 'staff', 'reports'],
  manager: ['pos', 'orders', 'kitchen', 'tables', 'menu', 'staff', 'reports'],
  cashier: ['pos', 'orders', 'tables'],
  waiter: ['pos', 'orders', 'tables'],
  kitchen: ['kitchen'],
};
const VIEW_LABELS = {
  pos: 'New order', orders: 'Active orders', kitchen: 'Kitchen display',
  tables: 'Tables', menu: 'Menu', staff: 'Staff', reports: 'Reports',
};

const state = { restaurant: null, categories: [], items: [], tables: [], cart: [], currentView: null };

async function bootstrap() {
  const { restaurant } = await api('/api/auth/me');
  state.restaurant = restaurant;
  document.getElementById('tenant-name').textContent = restaurant ? restaurant.name : '';

  const views = ROLE_VIEWS[user.role];
  document.getElementById('nav').innerHTML = views
    .map((v) => `<button class="navlink" data-view="${v}">${VIEW_LABELS[v]}</button>`)
    .join('');
  document.querySelectorAll('.navlink[data-view]').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

  showView(views[0]);
  connectRealtime();
}

function showView(view) {
  state.currentView = view;
  document.querySelectorAll('.navlink[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('view-title').textContent = VIEW_LABELS[view];
  const renderers = { pos: renderPos, orders: renderOrders, kitchen: renderKitchen, tables: renderTables, menu: renderMenu, staff: renderStaff, reports: renderReports };
  renderers[view]();
}

function connectRealtime() {
  const socket = connectSocket();
  const refreshIfVisible = (views) => {
    if (views.includes(state.currentView)) showView(state.currentView);
  };
  socket.on('order:new', () => refreshIfVisible(['orders', 'kitchen', 'pos']));
  socket.on('order:updated', () => refreshIfVisible(['orders', 'kitchen', 'pos']));
  socket.on('order_item:updated', () => refreshIfVisible(['orders', 'kitchen']));
  socket.on('table:updated', () => refreshIfVisible(['tables', 'pos']));
}

// ---------- POS: build a new order ----------
async function renderPos() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="menu-pos-grid">
    <div>
      <div class="field"><input id="pos-search" placeholder="Search menu…" /></div>
      <div id="pos-items"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Current order</h3>
      <div class="field"><label>Table (optional)</label><select id="pos-table"><option value="">Takeaway / no table</option></select></div>
      <div class="field"><label>Order type</label>
        <select id="pos-type"><option value="dine_in">Dine-in</option><option value="takeaway">Takeaway</option><option value="delivery">Delivery</option></select>
      </div>
      <div class="field"><label>Customer name (optional)</label><input id="pos-customer" /></div>
      <div id="pos-cart"></div>
      <div class="spread" style="margin-top:10px;"><strong>Total</strong><strong id="pos-total">$0.00</strong></div>
      <button style="width:100%;margin-top:10px;" onclick="submitOrder()">Send to kitchen</button>
      <div class="error-text" id="pos-error" style="display:none;"></div>
    </div>
  </div>`;

  const [{ items }, { categories }, { tables }] = await Promise.all([
    api('/api/menu/items'), api('/api/menu/categories'), api('/api/tables'),
  ]);
  state.items = items; state.categories = categories; state.tables = tables; state.cart = [];

  const tableSelect = document.getElementById('pos-table');
  tables.filter((t) => t.status !== 'occupied').forEach((t) => {
    tableSelect.insertAdjacentHTML('beforeend', `<option value="${t.id}">${escapeHtml(t.name)}</option>`);
  });

  renderPosItems(items);
  renderCart();
  document.getElementById('pos-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    renderPosItems(items.filter((i) => i.name.toLowerCase().includes(q)));
  });
}

function renderPosItems(items) {
  const byCategory = new Map();
  for (const item of items) {
    if (!item.is_available) continue;
    const key = item.category_id || 'none';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(item);
  }
  let html = '';
  for (const [catId, catItems] of byCategory) {
    const cat = state.categories.find((c) => c.id === catId);
    html += `<h4 class="muted">${cat ? escapeHtml(cat.name) : 'Other'}</h4>`;
    for (const item of catItems) {
      const hasSizes = item.sizes && item.sizes.length;
      const priceLabel = hasSizes ? `from ${fmtMoney(Math.min(...item.sizes.map((s) => s.price)), state.restaurant?.currency)}` : fmtMoney(item.price, state.restaurant?.currency);
      html += `<button class="item-btn secondary" onclick="addToCart(${item.id})">${escapeHtml(item.name)}<span class="price">${priceLabel}</span></button>`;
    }
  }
  document.getElementById('pos-items').innerHTML = html || '<p class="muted">No menu items yet. Add some in the Menu tab.</p>';
}

function addToCart(itemId, sizeId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!sizeId && item.sizes && item.sizes.length) {
    openSizeChooser(item);
    return;
  }
  const size = sizeId ? item.sizes.find((s) => s.id === sizeId) : null;
  const key = `${itemId}:${sizeId || 'base'}`;
  const line = state.cart.find((l) => l.key === key);
  if (line) line.qty += 1;
  else {
    state.cart.push({
      key,
      menu_item_id: itemId,
      size_id: sizeId || null,
      name: size ? `${item.name} (${size.name})` : item.name,
      price: size ? size.price : item.price,
      qty: 1,
    });
  }
  renderCart();
}
function changeQty(key, delta) {
  const line = state.cart.find((l) => l.key === key);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) state.cart = state.cart.filter((l) => l.key !== key);
  renderCart();
}
function renderCart() {
  const el = document.getElementById('pos-cart');
  el.innerHTML = state.cart.map((l) => `
    <div class="cart-line">
      <span>${escapeHtml(l.name)}</span>
      <span class="row">
        <button class="small secondary" onclick="changeQty('${l.key}', -1)">-</button>
        ${l.qty}
        <button class="small secondary" onclick="changeQty('${l.key}', 1)">+</button>
      </span>
    </div>`).join('') || '<p class="muted">Cart is empty</p>';
  const total = state.cart.reduce((s, l) => s + l.price * l.qty, 0);
  document.getElementById('pos-total').textContent = fmtMoney(total, state.restaurant?.currency);
}

function openSizeChooser(item) {
  document.getElementById('size-modal-title').textContent = `${item.name} — choose a size`;
  document.getElementById('size-modal-options').innerHTML = item.sizes
    .map((s) => `<button class="secondary" style="text-align:left;" onclick="addToCart(${item.id}, ${s.id}); closeSizeModal();">${escapeHtml(s.name)}<span class="price">${fmtMoney(s.price, state.restaurant?.currency)}</span></button>`)
    .join('');
  document.getElementById('size-modal').style.display = 'flex';
}
function closeSizeModal() {
  document.getElementById('size-modal').style.display = 'none';
}

async function submitOrder() {
  const errorEl = document.getElementById('pos-error');
  errorEl.style.display = 'none';
  if (!state.cart.length) { errorEl.textContent = 'Add at least one item'; errorEl.style.display = 'block'; return; }
  try {
    await api('/api/orders', {
      method: 'POST',
      body: {
        table_id: document.getElementById('pos-table').value || null,
        order_type: document.getElementById('pos-type').value,
        customer_name: document.getElementById('pos-customer').value.trim() || null,
        items: state.cart.map((l) => ({ menu_item_id: l.menu_item_id, size_id: l.size_id, qty: l.qty })),
      },
    });
    toast('Order sent to kitchen');
    renderPos();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}

// ---------- Active orders board (front of house) ----------
async function renderOrders() {
  const content = document.getElementById('content');
  content.innerHTML = '<div id="orders-list" class="grid"></div>';
  const { orders } = await api('/api/orders');
  const list = document.getElementById('orders-list');
  if (!orders.length) { list.innerHTML = '<p class="muted">No active orders.</p>'; return; }

  list.innerHTML = orders.map((o) => `
    <div class="card">
      <div class="spread">
        <strong>Order #${o.id}${o.table_id ? ` — Table ${tableName(o.table_id)}` : ` — ${escapeHtml(o.order_type)}`}</strong>
        <span class="badge status-${o.status}">${o.status}</span>
      </div>
      <div class="items">${o.items.map((i) => `${i.qty}× ${escapeHtml(i.name_snapshot)} <span class="badge status-${i.status}">${i.status}</span>`).join(', ')}</div>
      <div class="spread">
        <span>Total ${fmtMoney(o.total, state.restaurant?.currency)} · Paid ${fmtMoney(o.paid_total, state.restaurant?.currency)}</span>
      </div>
      <div class="actions">
        ${o.status === 'ready' ? `<button class="small" onclick="setOrderStatus(${o.id}, 'served')">Mark served</button>` : ''}
        ${!['billed', 'paid', 'cancelled'].includes(o.status) ? `<button class="small secondary" onclick="setOrderStatus(${o.id}, 'billed')">Send bill</button>` : ''}
        ${o.paid_total < o.total ? `<button class="small" onclick="collectPayment(${o.id}, ${(o.total - o.paid_total).toFixed(2)})">Collect payment</button>` : ''}
        ${o.status !== 'cancelled' && o.status !== 'paid' ? `<button class="small danger" onclick="setOrderStatus(${o.id}, 'cancelled')">Cancel</button>` : ''}
      </div>
    </div>`).join('');
}

function tableName(id) {
  const t = state.tables.find((t) => t.id === id);
  return t ? escapeHtml(t.name) : id;
}

async function setOrderStatus(id, status) {
  await api(`/api/orders/${id}`, { method: 'PATCH', body: { status } });
  toast(`Order #${id} → ${status}`);
  renderOrders();
}

async function collectPayment(orderId, suggestedAmount) {
  const amount = Number(prompt(`Amount received (${state.restaurant?.currency || 'USD'})`, suggestedAmount));
  if (!amount || amount <= 0) return;
  const method = prompt('Payment method (cash / card / other)', 'cash') || 'cash';
  await api(`/api/orders/${orderId}/payments`, { method: 'POST', body: { amount, method } });
  toast('Payment recorded');
  renderOrders();
}

// ---------- Kitchen display system ----------
async function renderKitchen() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="kanban">
    <div class="kanban-col"><h3>Pending</h3><div id="kds-pending"></div></div>
    <div class="kanban-col"><h3>Preparing</h3><div id="kds-preparing"></div></div>
    <div class="kanban-col"><h3>Ready</h3><div id="kds-ready"></div></div>
    <div class="kanban-col"><h3>Served</h3><div id="kds-served"></div></div>
  </div>`;
  const { orders } = await api('/api/orders');

  const cols = { pending: [], preparing: [], ready: [], served: [] };
  for (const order of orders) {
    for (const item of order.items) {
      if (cols[item.status]) cols[item.status].push({ order, item });
    }
  }
  const nextStatus = { pending: 'preparing', preparing: 'ready', ready: 'served' };
  for (const [status, entries] of Object.entries(cols)) {
    const el = document.getElementById(`kds-${status}`);
    el.innerHTML = entries.map(({ order, item }) => `
      <div class="order-card">
        <strong>#${order.id}${order.table_id ? ` · ${tableName(order.table_id)}` : ''}</strong>
        <div>${item.qty}× ${escapeHtml(item.name_snapshot)}</div>
        ${item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : ''}
        ${nextStatus[status] ? `<div class="actions"><button class="small" onclick="advanceItem(${order.id}, ${item.id}, '${nextStatus[status]}')">${nextStatus[status]}</button></div>` : ''}
      </div>`).join('') || '<p class="muted" style="font-size:12px;">Empty</p>';
  }
}

async function advanceItem(orderId, itemId, status) {
  await api(`/api/orders/${orderId}/items/${itemId}`, { method: 'PATCH', body: { status } });
  renderKitchen();
}

// ---------- Tables ----------
async function renderTables() {
  const content = document.getElementById('content');
  const canManage = ['owner', 'manager'].includes(user.role);
  content.innerHTML = `
    ${canManage ? `<div class="card" style="margin-bottom:16px;">
      <h3 style="margin-top:0;">Add table</h3>
      <div class="row"><input id="new-table-name" placeholder="Table name" style="flex:2;" /><input id="new-table-capacity" type="number" placeholder="Capacity" value="2" style="flex:1;" /><button onclick="addTable()">Add</button></div>
    </div>` : ''}
    <div class="grid" style="grid-template-columns:repeat(auto-fill, minmax(160px,1fr));" id="tables-grid"></div>`;
  const { tables } = await api('/api/tables');
  state.tables = tables;
  document.getElementById('tables-grid').innerHTML = tables.map((t) => `
    <div class="card">
      <div class="spread"><strong>${escapeHtml(t.name)}</strong><span class="badge status-${t.status}">${t.status}</span></div>
      <div class="muted">Seats ${t.capacity}</div>
      <div class="actions">
        ${t.status !== 'free' ? `<button class="small secondary" onclick="setTableStatus(${t.id}, 'free')">Free up</button>` : ''}
        ${t.status === 'free' ? `<button class="small secondary" onclick="setTableStatus(${t.id}, 'reserved')">Reserve</button>` : ''}
      </div>
    </div>`).join('') || '<p class="muted">No tables yet.</p>';
}
async function addTable() {
  const name = document.getElementById('new-table-name').value.trim();
  const capacity = Number(document.getElementById('new-table-capacity').value) || 2;
  if (!name) return;
  await api('/api/tables', { method: 'POST', body: { name, capacity } });
  renderTables();
}
async function setTableStatus(id, status) {
  await api(`/api/tables/${id}`, { method: 'PATCH', body: { status } });
  renderTables();
}

// ---------- Menu management ----------
async function renderMenu() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <h3 style="margin-top:0;">Add category</h3>
      <div class="row"><input id="new-cat-name" placeholder="Category name" /><button onclick="addCategory()">Add</button></div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <h3 style="margin-top:0;">Add menu item</h3>
      <div class="row">
        <select id="new-item-category" style="flex:1;"></select>
        <input id="new-item-name" placeholder="Item name" style="flex:2;" />
        <input id="new-item-price" type="number" step="0.01" placeholder="Price" style="flex:1;" />
        <button onclick="addItem()">Add</button>
      </div>
      <div class="field" style="margin-top:8px;margin-bottom:0;"><input id="new-item-description" placeholder="Description (optional)" /></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0;">Add a photo or size modifiers (Small/Medium/Large) after creating the item, via Edit.</p>
    </div>
    <div class="card"><table><thead><tr><th></th><th>Item</th><th>Category</th><th>Price</th><th>Available</th><th></th></tr></thead><tbody id="menu-table"></tbody></table></div>`;

  const [{ categories }, { items }] = await Promise.all([api('/api/menu/categories'), api('/api/menu/items')]);
  state.categories = categories; state.items = items;

  document.getElementById('new-item-category').innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') || '<option value="">No category</option>';

  document.getElementById('menu-table').innerHTML = items.map((i) => {
    const cat = categories.find((c) => c.id === i.category_id);
    const priceLabel = i.sizes && i.sizes.length ? `${i.sizes.length} sizes` : fmtMoney(i.price, state.restaurant?.currency);
    return `<tr>
      <td>${i.image_url ? `<img src="${escapeHtml(i.image_url)}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;" />` : ''}</td>
      <td>${escapeHtml(i.name)}</td>
      <td class="muted">${cat ? escapeHtml(cat.name) : '—'}</td>
      <td>${priceLabel}</td>
      <td><span class="badge status-${i.is_available ? 'active' : 'disabled'}">${i.is_available ? 'Yes' : 'No'}</span></td>
      <td class="row">
        <button class="small secondary" onclick="openItemModal(${i.id})">Edit</button>
        <button class="small secondary" onclick="toggleItemAvailable(${i.id}, ${i.is_available ? 0 : 1})">${i.is_available ? 'Hide' : 'Show'}</button>
        <button class="small danger" onclick="deleteItem(${i.id})">Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No items yet.</td></tr>';
}
async function addCategory() {
  const name = document.getElementById('new-cat-name').value.trim();
  if (!name) return;
  await api('/api/menu/categories', { method: 'POST', body: { name } });
  renderMenu();
}
async function addItem() {
  const category_id = document.getElementById('new-item-category').value || null;
  const name = document.getElementById('new-item-name').value.trim();
  const price = Number(document.getElementById('new-item-price').value);
  const description = document.getElementById('new-item-description').value.trim();
  if (!name || !price) return;
  await api('/api/menu/items', { method: 'POST', body: { category_id, name, price, description: description || null } });
  renderMenu();
}

// ---------- Menu item edit modal: description, photo upload, size modifiers ----------
let editingItem = null;

function openItemModal(itemId) {
  editingItem = state.items.find((i) => i.id === itemId);
  if (!editingItem) return;

  document.getElementById('im-error').style.display = 'none';
  document.getElementById('im-photo-error').style.display = 'none';
  document.getElementById('im-name').value = editingItem.name;
  document.getElementById('im-price').value = editingItem.price;
  document.getElementById('im-description').value = editingItem.description || '';
  document.getElementById('im-available').checked = !!editingItem.is_available;
  document.getElementById('im-photo-input').value = '';

  const categorySelect = document.getElementById('im-category');
  categorySelect.innerHTML = '<option value="">No category</option>' + state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  categorySelect.value = editingItem.category_id || '';

  const preview = document.getElementById('im-photo-preview');
  if (editingItem.image_url) { preview.src = editingItem.image_url; preview.style.display = 'block'; }
  else preview.style.display = 'none';

  renderSizesList();
  document.getElementById('item-modal').style.display = 'flex';
}
function closeItemModal() {
  document.getElementById('item-modal').style.display = 'none';
  editingItem = null;
}

function renderSizesList() {
  document.getElementById('im-sizes-list').innerHTML = (editingItem.sizes || []).map((s) => `
    <div class="cart-line">
      <span>${escapeHtml(s.name)}</span>
      <span class="row">${fmtMoney(s.price, state.restaurant?.currency)}<button type="button" class="small danger" onclick="deleteSize(${s.id})">Remove</button></span>
    </div>`).join('') || '<p class="muted" style="font-size:12px;">No size modifiers — the base price is used as-is.</p>';
}

async function addSize() {
  const name = document.getElementById('im-size-name').value.trim();
  const price = Number(document.getElementById('im-size-price').value);
  if (!name || !price) return;
  const { size } = await api(`/api/menu/items/${editingItem.id}/sizes`, { method: 'POST', body: { name, price } });
  editingItem.sizes = [...(editingItem.sizes || []), size];
  document.getElementById('im-size-name').value = '';
  document.getElementById('im-size-price').value = '';
  renderSizesList();
}
async function deleteSize(sizeId) {
  await api(`/api/menu/items/${editingItem.id}/sizes/${sizeId}`, { method: 'DELETE' });
  editingItem.sizes = editingItem.sizes.filter((s) => s.id !== sizeId);
  renderSizesList();
}

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'im-photo-input' || !editingItem) return;
  const file = e.target.files[0];
  if (!file) return;

  const errorEl = document.getElementById('im-photo-error');
  errorEl.style.display = 'none';
  try {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/menu/images', { method: 'POST', headers: { Authorization: `Bearer ${Auth.token}` }, body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    await api(`/api/menu/items/${editingItem.id}`, { method: 'PATCH', body: { image_url: data.url } });
    editingItem.image_url = data.url;
    const preview = document.getElementById('im-photo-preview');
    preview.src = data.url;
    preview.style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});

async function saveItemModal() {
  const errorEl = document.getElementById('im-error');
  errorEl.style.display = 'none';
  try {
    await api(`/api/menu/items/${editingItem.id}`, {
      method: 'PATCH',
      body: {
        name: document.getElementById('im-name').value.trim(),
        category_id: document.getElementById('im-category').value || null,
        price: Number(document.getElementById('im-price').value),
        description: document.getElementById('im-description').value.trim() || null,
        is_available: document.getElementById('im-available').checked,
      },
    });
    closeItemModal();
    renderMenu();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}
async function toggleItemAvailable(id, isAvailable) {
  await api(`/api/menu/items/${id}`, { method: 'PATCH', body: { is_available: !!isAvailable } });
  renderMenu();
}
async function deleteItem(id) {
  if (!confirm('Delete this menu item?')) return;
  await api(`/api/menu/items/${id}`, { method: 'DELETE' });
  renderMenu();
}

// ---------- Staff ----------
async function renderStaff() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <h3 style="margin-top:0;">Add staff member</h3>
      <div class="row">
        <input id="new-staff-name" placeholder="Full name" />
        <input id="new-staff-email" type="email" placeholder="Email" />
        <select id="new-staff-role"><option value="waiter">Waiter</option><option value="cashier">Cashier</option><option value="kitchen">Kitchen</option><option value="manager">Manager</option></select>
        <button onclick="addStaff()">Add</button>
      </div>
    </div>
    <div class="card"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody id="staff-table"></tbody></table></div>`;

  const { staff } = await api('/api/staff');
  document.getElementById('staff-table').innerHTML = staff.map((s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td class="muted">${escapeHtml(s.email)}</td>
      <td>${escapeHtml(s.role)}</td>
      <td><span class="badge status-${s.status === 'active' ? 'active' : 'disabled'}">${s.status}</span></td>
      <td class="row">
        <button class="small secondary" onclick="toggleStaffStatus(${s.id}, '${s.status}')">${s.status === 'active' ? 'Disable' : 'Enable'}</button>
        <button class="small danger" onclick="deleteStaff(${s.id})">Remove</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No staff added yet.</td></tr>';
}
async function addStaff() {
  const name = document.getElementById('new-staff-name').value.trim();
  const email = document.getElementById('new-staff-email').value.trim();
  const role = document.getElementById('new-staff-role').value;
  if (!name || !email) return;
  const { temporary_password } = await api('/api/staff', { method: 'POST', body: { name, email, role } });
  alert(`Staff account created.\nEmail: ${email}\nTemporary password: ${temporary_password}`);
  renderStaff();
}
async function toggleStaffStatus(id, status) {
  await api(`/api/staff/${id}`, { method: 'PATCH', body: { status: status === 'active' ? 'disabled' : 'active' } });
  renderStaff();
}
async function deleteStaff(id) {
  if (!confirm('Remove this staff member?')) return;
  await api(`/api/staff/${id}`, { method: 'DELETE' });
  renderStaff();
}

// ---------- Reports ----------
async function renderReports() {
  const content = document.getElementById('content');
  const today = new Date().toISOString().slice(0, 10);
  content.innerHTML = `
    <div class="field" style="max-width:200px;"><label>Date</label><input type="date" id="report-date" value="${today}" /></div>
    <div class="stat-grid" id="report-stats"></div>
    <div class="card" style="margin-bottom:16px;">
      <h3 style="margin-top:0;">Top items</h3>
      <table><thead><tr><th>Item</th><th>Qty sold</th><th>Revenue</th></tr></thead><tbody id="report-items"></tbody></table>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">By payment method</h3>
      <table><thead><tr><th>Method</th><th>Count</th><th>Total</th></tr></thead><tbody id="report-methods"></tbody></table>
    </div>`;
  document.getElementById('report-date').addEventListener('change', (e) => loadReport(e.target.value));
  loadReport(today);
}
async function loadReport(date) {
  const { summary, top_items, by_payment_method } = await api('/api/reports/daily', { params: { date } });
  document.getElementById('report-stats').innerHTML = `
    <div class="stat-card"><div class="value">${summary.order_count}</div><div class="label">Orders</div></div>
    <div class="stat-card"><div class="value">${fmtMoney(summary.revenue, state.restaurant?.currency)}</div><div class="label">Revenue</div></div>`;
  document.getElementById('report-items').innerHTML = top_items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${i.qty_sold}</td><td>${fmtMoney(i.revenue, state.restaurant?.currency)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No sales</td></tr>';
  document.getElementById('report-methods').innerHTML = by_payment_method.map((m) => `<tr><td>${escapeHtml(m.method)}</td><td>${m.count}</td><td>${fmtMoney(m.total, state.restaurant?.currency)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No payments</td></tr>';
}

bootstrap();
