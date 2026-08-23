const API_BASE = window.API_BASE || 'http://localhost:4000';

function getToken() {
  return localStorage.getItem('clinic_token');
}
function getUser() {
  const raw = localStorage.getItem('clinic_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('clinic_token', token);
  localStorage.setItem('clinic_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('clinic_token');
  localStorage.removeItem('clinic_user');
}
function requireRole(...roles) {
  const user = getUser();
  if (!getToken() || !user || !roles.includes(user.role)) {
    window.location.href = 'login.html';
  }
  return user;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (err) {
    throw new Error('Could not reach the server. Is the backend running?');
  }

  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') {
      clearSession();
    }
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return body;
}

function renderNav(activeUserEmail) {
  const nav = document.getElementById('portal-nav');
  if (!nav) return;
  const user = getUser();
  nav.innerHTML = user
    ? `<span class="me-3">${user.name} <small class="text-muted">(${user.role})</small></span>
       <a href="#" id="logout-link" class="btn btn-sm btn-outline-secondary">Log out</a>`
    : `<a href="login.html" class="btn btn-sm btn-outline-primary me-2">Log in</a>
       <a href="register.html" class="btn btn-sm btn-primary">Register</a>`;

  document.getElementById('logout-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    clearSession();
    window.location.href = 'login.html';
  });
}

function showAlert(el, message, type = 'danger') {
  el.innerHTML = `<div class="alert alert-${type}" role="alert">${message}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
