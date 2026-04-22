// ── Tauri IPC ──
const { invoke } = window.__TAURI__.core;

// ── State ──
let currentView = 'dashboard';
let roles = [];
let tasks = [];
let contacts = [];
let pipelineStats = null;

// ── Router ──
const routes = {
  '/': 'dashboard',
  '/roles': 'roles',
  '/roles/:id': 'roleDetail',
  '/tasks': 'tasks',
  '/contacts': 'contacts',
  '/contacts/:id': 'contactDetail',
  '/search': 'search',
  '/profile': 'profile',
  '/settings': 'settings',
};

export function navigate(hash) {
  window.location.hash = hash;
}

function getRoute() {
  const hash = window.location.hash.slice(1) || '/';
  // Check for parameterized routes
  if (hash.startsWith('/roles/') && hash !== '/roles') {
    return { view: 'roleDetail', params: { id: hash.split('/')[2] } };
  }
  if (hash.startsWith('/contacts/') && hash !== '/contacts') {
    return { view: 'contactDetail', params: { id: hash.split('/')[2] } };
  }
  return { view: routes[hash] || 'dashboard', params: {} };
}

// ── Views ──
import { renderDashboard } from './views/dashboard.js';
import { renderRoles, renderRoleDetail } from './views/roles.js';
import { renderTasks } from './views/tasks.js';
import { renderContacts, renderContactDetail } from './views/contacts.js';
import { renderSearch } from './views/search.js';
import { renderSettings } from './views/settings.js';
import { renderProfile } from './views/profile.js';
import { closeChat, getCurrentChatScopeType } from './views/chat.js';

async function renderView() {
  const { view, params } = getRoute();
  currentView = view;
  const container = document.getElementById('view-container');

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === view ||
      (view === 'roleDetail' && link.dataset.view === 'roles') ||
      (view === 'contactDetail' && link.dataset.view === 'contacts'));
  });

  // Chat drawer is scope-aware — keep open only when the current scope matches
  // the new view. Role scope lives on roleDetail; profile scope lives on profile.
  const chatScope = getCurrentChatScopeType();
  const keepChat =
    (view === 'roleDetail' && chatScope === 'role') ||
    (view === 'profile' && chatScope === 'profile');
  if (!keepChat) {
    closeChat().catch(() => {});
  }

  try {
    switch (view) {
      case 'dashboard':
        await renderDashboard(container);
        break;
      case 'roles':
        await renderRoles(container);
        break;
      case 'roleDetail':
        await renderRoleDetail(container, params.id);
        break;
      case 'tasks':
        await renderTasks(container);
        break;
      case 'contacts':
        await renderContacts(container);
        break;
      case 'contactDetail':
        await renderContactDetail(container, params.id);
        break;
      case 'search':
        await renderSearch(container);
        break;
      case 'profile':
        await renderProfile(container);
        break;
      case 'settings':
        await renderSettings(container);
        break;
      default:
        container.innerHTML = '<div class="empty-state"><p>View not found</p></div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="card"><h3>Error</h3><p>${escapeHtml(err.toString())}</p></div>`;
    console.error(err);
  }
}

// ── Helpers (exported for views) ──
export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function showModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  content.innerHTML = html;
  overlay.classList.remove('hidden');
}

export function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

export function stageBadgeClass(stage) {
  const map = {
    'Sourced': 'badge-sourced',
    'Applied': 'badge-applied',
    'Recruiter Screen': 'badge-recruiter',
    'HM Interview': 'badge-hm',
    'Onsite': 'badge-onsite',
    'Offer': 'badge-offer',
    'Negotiating': 'badge-negotiating',
  };
  return map[stage] || 'badge-sourced';
}

export function fitScoreClass(score) {
  if (score >= 90) return 'exceptional';
  if (score >= 85) return 'strong';
  if (score >= 80) return 'good';
  if (score >= 75) return 'risk';
  if (score >= 70) return 'stretch';
  return 'weak';
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Minimal markdown → HTML. Handles headers, bold, italic, inline code,
// fenced code blocks, unordered lists, and paragraphs. Escapes HTML first.
export function renderMarkdown(src) {
  if (!src) return '';
  let text = src
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Fenced code blocks (```...```)
  text = text.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Headers (order matters: longer prefix first)
  text = text
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold, italic, inline code
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bulleted lists (consecutive "- " lines become one <ul>)
  text = text.replace(/(^- .+(?:\n- .+)*)/gm, (block) => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Paragraphs: split on blank lines, wrap plain blocks in <p>
  return text.split(/\n{2,}/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|pre)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

export { invoke };

// ── Nav history (back/forward) ──
// Delegates to the browser's own hash-based history stack. We don't shadow
// the stack — the browser already knows how deep we are, and `history.back()`
// on the first entry is a harmless no-op.
window.addEventListener('hashchange', renderView);

document.getElementById('nav-back').addEventListener('click', () => window.history.back());
document.getElementById('nav-forward').addEventListener('click', () => window.history.forward());

// Keyboard shortcuts.
// Cmd-[/] for history nav; Cmd-R for reload (Tauri webviews don't bind it by default).
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '[') {
    e.preventDefault();
    window.history.back();
  } else if (e.key === ']') {
    e.preventDefault();
    window.history.forward();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    window.location.reload();
  }
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// Initial render
renderView();
