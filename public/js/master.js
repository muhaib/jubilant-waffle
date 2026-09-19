Auth.requireRole(['super_admin']);

let restaurantsCache = [];

document.querySelectorAll('.navlink[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function showView(view) {
  document.querySelectorAll('[id^="view-"]').forEach((el) => (el.style.display = 'none'));
  document.getElementById(`view-${view}`).style.display = 'block';
  document.querySelectorAll('.navlink[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'dashboard') loadDashboard();
  if (view === 'restaurants') loadRestaurants();
}

async function loadDashboard() {
  const { totals, top_restaurants } = await api('/api/admin/stats');
  document.getElementById('stats').innerHTML = `
    <div class="stat-card"><div class="value">${totals.restaurants}</div><div class="label">Restaurants</div></div>
    <div class="stat-card"><div class="value">${totals.active_restaurants}</div><div class="label">Active</div></div>
    <div class="stat-card"><div class="value">${totals.orders_today}</div><div class="label">Orders today</div></div>
    <div class="stat-card"><div class="value">${fmtMoney(totals.revenue_today)}</div><div class="label">Revenue today</div></div>
  `;
  document.getElementById('top-restaurants').innerHTML = top_restaurants
    .map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${r.order_count}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="muted">No data yet</td></tr>';
}

async function loadRestaurants() {
  const { restaurants } = await api('/api/admin/restaurants');
  restaurantsCache = restaurants;
  document.getElementById('restaurants-table').innerHTML = restaurants
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="muted">${escapeHtml(r.slug)}</td>
        <td>${escapeHtml(r.plan)}</td>
        <td><span class="badge status-${r.status}">${r.status}</span></td>
        <td>${r.order_count}</td>
        <td>${r.staff_count}</td>
        <td class="row">
          <button class="small secondary" onclick="toggleStatus(${r.id}, '${r.status}')">${r.status === 'active' ? 'Suspend' : 'Activate'}</button>
          <button class="small secondary" onclick="resetOwnerPassword(${r.id})">Reset owner pwd</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="7" class="muted">No restaurants yet — create the first one.</td></tr>';
}

async function toggleStatus(id, currentStatus) {
  const status = currentStatus === 'active' ? 'suspended' : 'active';
  await api(`/api/admin/restaurants/${id}`, { method: 'PATCH', body: { status } });
  toast(`Restaurant ${status}`);
  loadRestaurants();
}

async function resetOwnerPassword(id) {
  const { temporary_password } = await api(`/api/admin/restaurants/${id}/reset-owner-password`, { method: 'POST' });
  showCredentials(`<p><strong>New temporary password:</strong></p><p style="font-family:monospace;font-size:16px;">${escapeHtml(temporary_password)}</p>`);
}

function openCreateModal() {
  document.getElementById('create-form').reset();
  document.getElementById('create-error').style.display = 'none';
  document.getElementById('create-modal').style.display = 'flex';
}
function closeCreateModal() {
  document.getElementById('create-modal').style.display = 'none';
}

function showCredentials(html) {
  document.getElementById('credentials-body').innerHTML = html;
  document.getElementById('credentials-modal').style.display = 'flex';
}

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('create-error');
  errorEl.style.display = 'none';
  try {
    const body = {
      name: document.getElementById('c-name').value.trim(),
      owner_name: document.getElementById('c-owner-name').value.trim(),
      owner_email: document.getElementById('c-owner-email').value.trim(),
      plan: document.getElementById('c-plan').value,
      currency: document.getElementById('c-currency').value.trim() || 'USD',
      phone: document.getElementById('c-phone').value.trim(),
      address: document.getElementById('c-address').value.trim(),
    };
    const { restaurant, owner_login } = await api('/api/admin/restaurants', { method: 'POST', body });
    closeCreateModal();
    showCredentials(`
      <p><strong>${escapeHtml(restaurant.name)}</strong> is live at slug <code>${escapeHtml(restaurant.slug)}</code>.</p>
      <p>Owner login:</p>
      <p style="font-family:monospace;">${escapeHtml(owner_login.email)}<br/>${escapeHtml(owner_login.temporary_password)}</p>
    `);
    loadRestaurants();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
});

const socket = connectSocket();
socket.on('restaurant:created', () => { if (document.getElementById('view-restaurants').style.display !== 'none') loadRestaurants(); loadDashboard(); });
socket.on('restaurant:updated', () => { if (document.getElementById('view-restaurants').style.display !== 'none') loadRestaurants(); });
socket.on('order:new', loadDashboard);

showView('dashboard');
