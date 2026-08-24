const STATUS_PILL = {
  CONFIRMED: ['pill-blue', 'bi-check-circle'],
  HELD: ['pill-amber', 'bi-hourglass-split'],
  COMPLETED: ['pill-green', 'bi-clipboard2-check'],
  CANCELLED: ['pill-grey', 'bi-x-circle'],
  EXPIRED: ['pill-grey', 'bi-clock-history'],
  NO_SHOW: ['pill-red', 'bi-person-x'],
};

const URGENCY_PILL = {
  High: ['pill-red', 'bi-exclamation-triangle-fill'],
  Medium: ['pill-amber', 'bi-exclamation-circle-fill'],
  Low: ['pill-green', 'bi-check-circle-fill'],
};

function statusPill(status) {
  const [cls, icon] = STATUS_PILL[status] || ['pill-grey', 'bi-circle'];
  const label = status.charAt(0) + status.slice(1).toLowerCase().replace('_', ' ');
  return `<span class="portal-pill ${cls}"><i class="bi ${icon}"></i>${label}</span>`;
}

function urgencyPill(level) {
  const [cls, icon] = URGENCY_PILL[level] || ['pill-grey', 'bi-circle'];
  return `<span class="portal-pill ${cls}"><i class="bi ${icon}"></i>${escapeHtml(level)} urgency</span>`;
}

function initials(name) {
  return (name || '?')
    .replace(/\[DEMO\]\s*/i, '')
    .replace(/^Dr\.?\s*/i, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function avatar(name, extraClass = '') {
  return `<div class="portal-avatar ${extraClass}">${escapeHtml(initials(name))}</div>`;
}

function cleanName(name) {
  return (name || '').replace(/\[DEMO\]\s*/i, '');
}

/** "2026-08-25" -> "Tue, 25 Aug 2026" */
function prettyDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "14:30" -> "2:30 PM" */
function prettyTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

const NAV_LINKS = {
  PATIENT: [
    { href: 'dashboard-patient.html', label: 'My appointments' },
    { href: 'book.html', label: 'Book appointment' },
  ],
  DOCTOR: [{ href: 'dashboard-doctor.html', label: 'My schedule' }],
  ADMIN: [{ href: 'dashboard-admin.html', label: 'Admin' }],
};

function renderPortalNav() {
  const mount = document.getElementById('portal-nav');
  if (!mount) return;

  const user = getUser();
  const current = window.location.pathname.split('/').pop();
  const links = user ? NAV_LINKS[user.role] || [] : [];

  mount.innerHTML = `
    <nav class="portal-nav">
      <div class="container portal-nav-inner">
        <a class="portal-brand" href="index.html">
          <i class="bi bi-heart-pulse-fill"></i> Clinic
        </a>
        <div class="portal-nav-links">
          ${links
            .map(
              (l) =>
                `<a class="portal-link" href="${l.href}" ${
                  l.href === current ? 'style="color:var(--accent-color);background:#f2f7ff"' : ''
                }>${l.label}</a>`
            )
            .join('')}
          ${
            user
              ? `<div class="portal-user">
                   ${avatar(user.name)}
                   <div>
                     <div class="portal-user-name">${escapeHtml(cleanName(user.name))}</div>
                     <div class="portal-user-role">${escapeHtml(user.role)}</div>
                   </div>
                   <button id="logout-link" class="btn btn-sm btn-outline-secondary ms-2">
                     <i class="bi bi-box-arrow-right"></i>
                   </button>
                 </div>`
              : `<a class="btn btn-sm btn-outline-primary" href="login.html">Log in</a>
                 <a class="btn btn-sm btn-primary ms-2" href="register.html">Register</a>`
          }
        </div>
      </div>
    </nav>`;

  document.getElementById('logout-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    clearSession();
    window.location.href = 'login.html';
  });
}

function pageHeading(title, subtitle, actionsHtml = '') {
  return `
    <div class="portal-heading">
      <div class="container">
        <div class="d-flex flex-wrap justify-content-between align-items-end gap-3">
          <div>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(subtitle)}</p>
          </div>
          <div class="portal-heading-actions">${actionsHtml}</div>
        </div>
      </div>
    </div>`;
}

function emptyState(icon, message, actionHtml = '') {
  return `<div class="portal-empty">
    <i class="bi ${icon}"></i>
    <p>${escapeHtml(message)}</p>
    ${actionHtml}
  </div>`;
}

function skeletonCards(count = 2) {
  return Array.from({ length: count })
    .map(
      () => `<div class="portal-card"><div class="portal-card-body">
        <div class="placeholder-glow">
          <span class="placeholder col-4"></span><br>
          <span class="placeholder col-6 mt-2"></span>
        </div>
      </div></div>`
    )
    .join('');
}
