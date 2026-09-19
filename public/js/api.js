const Auth = {
  get token() { return localStorage.getItem('pos_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('pos_user')); } catch { return null; } },
  save(token, user) {
    localStorage.setItem('pos_token', token);
    localStorage.setItem('pos_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_user');
  },
  requireRole(roles, redirectTo = '/') {
    const user = Auth.user;
    if (!Auth.token || !user || !roles.includes(user.role)) {
      window.location.href = redirectTo;
      return null;
    }
    return user;
  },
  logout() {
    Auth.clear();
    window.location.href = '/';
  },
};

async function api(path, { method = 'GET', body, params } = {}) {
  let url = path;
  if (params) {
    const usp = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(Auth.token ? { Authorization: `Bearer ${Auth.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    Auth.clear();
    window.location.href = '/';
    throw new Error('Session expired');
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function connectSocket() {
  return io({ auth: { token: Auth.token } });
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function fmtMoney(amount, currency = 'USD') {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
