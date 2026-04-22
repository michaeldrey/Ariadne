import {
  invoke, escapeHtml, formatDate, stageBadgeClass, fitScoreClass,
  toast, showModal, closeModal, navigate, renderMarkdown,
} from '../app.js';
import { openChat, closeChat, openChatAndSend } from './chat.js';

const STAGES = ['Sourced', 'Applied', 'Recruiter Screen', 'HM Interview', 'Onsite', 'Offer', 'Negotiating'];
const OUTCOMES = ['Rejected', 'Withdrew', 'Accepted', 'Expired'];
const CONTENT_FIELDS = [
  { key: 'jd', label: 'JD', field: 'jd_content', empty: 'No job description yet.', placeholder: 'Paste the full job description here.' },
  { key: 'resume', label: 'Resume Draft', field: 'resume_draft', empty: 'No tailored resume yet. Use "Tailor Resume" to generate one.', placeholder: 'Tailored resume draft in markdown.' },
  { key: 'analysis', label: 'Analysis', field: 'comparison_analysis', empty: 'No analysis yet.', placeholder: 'Comparison / gap analysis in markdown.' },
  { key: 'research', label: 'Research', field: 'research_packet', empty: 'No research packet yet. Use "Research" to generate one.', placeholder: 'Company / team research packet in markdown.' },
];

// Per-view sort state.
let listSort = { key: 'updated_date', dir: 'desc' };
let activeTab = 'active';

// Background-analysis state. Keyed by role id so renderRoleDetail can
// re-hydrate the banner if the user navigated away and came back while
// analysis was still running.
const analyzingRoles = new Set();

function setAnalysisBanner(state, message) {
  const el = document.getElementById('analysis-status');
  if (!el) return;
  el.className = `analysis-status analysis-${state}`;
  const icon = state === 'running' ? '<div class="spinner"></div>'
    : state === 'success' ? '<span style="color:var(--green)">✓</span>'
    : state === 'error' ? '<span style="color:var(--red)">✕</span>'
    : '';
  el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
}

function hideAnalysisBanner() {
  const el = document.getElementById('analysis-status');
  if (el) el.className = 'analysis-status hidden';
}

async function autoAnalyzeRole(roleId) {
  if (analyzingRoles.has(roleId)) return;
  analyzingRoles.add(roleId);
  setAnalysisBanner('running', 'Analyzing JD — generating analysis + fit score…');
  try {
    await invoke('tailor_resume', { roleId });
    analyzingRoles.delete(roleId);
    // Re-render the current role detail if we're still on it. The data:changed
    // subscription doesn't fire for tailor_resume because it mutates columns
    // directly (not via a tool call), so we re-fetch manually.
    const container = document.getElementById('view-container');
    if (container && location.hash === `#/roles/${roleId}`) {
      await renderRoleDetail(container, roleId);
      setAnalysisBanner('success', 'Analysis + fit score updated');
      setTimeout(() => {
        // Only auto-hide if no newer analysis has started for this role.
        if (!analyzingRoles.has(roleId)) hideAnalysisBanner();
      }, 5000);
    }
  } catch (err) {
    analyzingRoles.delete(roleId);
    setAnalysisBanner('error', `Analysis failed: ${err}`);
  }
}

// Handle to the current `data:changed` subscription so we can drop it when
// re-rendering or navigating away. One listener at a time.
let dataChangedUnlisten = null;
async function subscribeDataChanged(handler) {
  if (dataChangedUnlisten) {
    try { dataChangedUnlisten(); } catch {}
    dataChangedUnlisten = null;
  }
  const { listen } = window.__TAURI__.event;
  dataChangedUnlisten = await listen('data:changed', (e) => handler(e.payload));
}

export async function renderRoles(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading roles...</div>';

  // Re-render on any role-scoped mutation so the list picks up stage changes
  // etc. from the chat without the user having to hit refresh.
  subscribeDataChanged((payload) => {
    if (payload.scope === 'role') renderRoles(container);
  });

  const allRoles = await invoke('list_roles', { status: null });
  const active = allRoles.filter(r => r.status === 'active');
  const closed = allRoles.filter(r => r.status === 'closed');
  const skipped = allRoles.filter(r => r.status === 'skipped');

  container.innerHTML = `
    <div class="flex-between mb-16">
      <h2>Roles (${allRoles.length})</h2>
      <button class="btn btn-primary" id="btn-add-role">+ Add Role</button>
    </div>

    <div class="tabs" id="role-tabs">
      <button class="tab ${activeTab === 'active' ? 'active' : ''}" data-tab="active">Active (${active.length})</button>
      <button class="tab ${activeTab === 'closed' ? 'active' : ''}" data-tab="closed">Closed (${closed.length})</button>
      <button class="tab ${activeTab === 'skipped' ? 'active' : ''}" data-tab="skipped">Skipped (${skipped.length})</button>
    </div>

    <div id="tab-active" class="tab-content ${activeTab === 'active' ? 'active' : ''}"></div>
    <div id="tab-closed" class="tab-content ${activeTab === 'closed' ? 'active' : ''}"></div>
    <div id="tab-skipped" class="tab-content ${activeTab === 'skipped' ? 'active' : ''}"></div>
  `;

  renderActiveTab(active);
  renderClosedTab(closed);
  renderSkippedTab(skipped);

  container.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${activeTab}`).classList.add('active');
    });
  });

  document.getElementById('btn-add-role').addEventListener('click', showAddRoleModal);
}

function renderActiveTab(active) {
  const sorted = sortRows(active, listSort.key, listSort.dir);
  const el = document.getElementById('tab-active');

  if (sorted.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No active roles. Add one to get started.</p></div>';
    return;
  }

  el.innerHTML = `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            ${sortTh('company', 'Company')}
            <th>Role</th>
            ${sortTh('fit_score', 'Fit')}
            ${sortTh('stage', 'Stage')}
            <th>Next Action</th>
            ${sortTh('updated_date', 'Updated')}
          </tr>
        </thead>
        <tbody>
          ${sorted.map(r => activeRow(r)).join('')}
        </tbody>
      </table>
    </div>
  `;

  wireSortHeaders(el, () => renderActiveTab(active));
  wireRowNav(el);
  wireStageDropdowns(el, () => {
    renderRoles(document.getElementById('view-container'));
  });
}

function renderClosedTab(closed) {
  const el = document.getElementById('tab-closed');
  if (closed.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No closed roles.</p></div>';
    return;
  }
  const sorted = [...closed].sort((a, b) => (b.closed_date || '').localeCompare(a.closed_date || ''));
  el.innerHTML = `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Company</th><th>Role</th><th>Stage Reached</th><th>Outcome</th><th>Closed</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(r => `
            <tr data-href="#/roles/${r.id}">
              <td><strong>${escapeHtml(r.company)}</strong></td>
              <td>${escapeHtml(r.title)}</td>
              <td><span class="badge ${stageBadgeClass(r.stage)}">${escapeHtml(r.stage)}</span></td>
              <td><span class="badge badge-${(r.outcome || 'closed').toLowerCase()}">${escapeHtml(r.outcome || 'Closed')}</span></td>
              <td class="text-muted text-sm">${formatDate(r.closed_date)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  wireRowNav(el);
}

function renderSkippedTab(skipped) {
  const el = document.getElementById('tab-skipped');
  if (skipped.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No skipped roles.</p></div>';
    return;
  }
  el.innerHTML = `
    <div class="table-container">
      <table>
        <thead>
          <tr><th>Company</th><th>Role</th><th>Reason</th><th>Updated</th></tr>
        </thead>
        <tbody>
          ${skipped.map(r => `
            <tr data-href="#/roles/${r.id}">
              <td><strong>${escapeHtml(r.company)}</strong></td>
              <td>${escapeHtml(r.title)}</td>
              <td class="text-sm text-muted">${escapeHtml(r.skip_reason) || '—'}</td>
              <td class="text-muted text-sm">${formatDate(r.updated_date)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  wireRowNav(el);
}

function activeRow(r) {
  return `
    <tr data-href="#/roles/${r.id}">
      <td><strong>${escapeHtml(r.company)}</strong></td>
      <td>${escapeHtml(r.title)}</td>
      <td>${r.fit_score ? `<span class="fit-score ${fitScoreClass(r.fit_score)}">${r.fit_score}</span>` : '—'}</td>
      <td>
        <select class="stage-inline" data-role-id="${r.id}" data-current="${escapeHtml(r.stage)}" onclick="event.stopPropagation()">
          ${STAGES.map(s => `<option value="${s}" ${s === r.stage ? 'selected' : ''}>${s}</option>`).join('')}
          <option disabled>──────</option>
          ${OUTCOMES.map(o => `<option value="${o}">${o}</option>`).join('')}
        </select>
      </td>
      <td class="text-sm">${escapeHtml(r.next_action) || '—'}</td>
      <td class="text-muted text-sm">${formatDate(r.updated_date)}</td>
    </tr>
  `;
}

function sortTh(key, label) {
  const indicator = listSort.key === key ? (listSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th data-sort-key="${key}">${label}${indicator}</th>`;
}

function sortRows(rows, key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp;
    if (key === 'stage') {
      // Pipeline order, not alphabetical. Unknown stages sink to the end.
      const ai = STAGES.indexOf(a.stage);
      const bi = STAGES.indexOf(b.stage);
      const aIdx = ai === -1 ? STAGES.length : ai;
      const bIdx = bi === -1 ? STAGES.length : bi;
      cmp = aIdx - bIdx;
    } else {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) cmp = 0;
      else if (av == null) cmp = 1;
      else if (bv == null) cmp = -1;
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
    }
    if (cmp !== 0) return cmp * mult;
    // Tie-breaker: company ascending, regardless of primary sort direction.
    return String(a.company || '').localeCompare(String(b.company || ''));
  });
}

function wireSortHeaders(scope, rerender) {
  scope.querySelectorAll('th[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (listSort.key === key) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
      else { listSort.key = key; listSort.dir = 'asc'; }
      rerender();
    });
  });
}

function wireRowNav(scope) {
  scope.querySelectorAll('tr[data-href]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('select, input, button, a')) return;
      window.location.hash = tr.dataset.href;
    });
  });
}

function wireStageDropdowns(scope, afterChange) {
  scope.querySelectorAll('.stage-inline').forEach(sel => {
    sel.addEventListener('change', async () => {
      const newStage = sel.value;
      const current = sel.dataset.current;
      const id = sel.dataset.roleId;
      if (newStage === current) return;

      const isOutcome = OUTCOMES.includes(newStage);
      if (isOutcome && !confirm(`Close this role as "${newStage}"?`)) {
        sel.value = current;
        return;
      }

      try {
        await invoke('update_stage', { id, stage: newStage });
        toast(`Stage updated to ${newStage}`, 'success');
        afterChange();
      } catch (err) {
        sel.value = current;
        toast(err.toString(), 'error');
      }
    });
  });
}

function showAddRoleModal() {
  showModal(`
    <h3>Add Role</h3>
    <form id="add-role-form">
      <div class="form-group">
        <label>Company</label>
        <input type="text" id="new-company" required placeholder="e.g. Stripe" />
      </div>
      <div class="form-group">
        <label>Role Title</label>
        <input type="text" id="new-title" required placeholder="e.g. Staff SWE, Infrastructure" />
      </div>
      <div class="form-group">
        <label>Job URL</label>
        <input type="url" id="new-url" placeholder="https://..." />
      </div>
      <div class="form-group">
        <label>Job Description</label>
        <textarea id="new-jd" placeholder="Paste the JD here (optional)"></textarea>
      </div>
      <div class="btn-group mt-16">
        <button type="submit" class="btn btn-primary">Add Role</button>
        <button type="button" class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
      </div>
    </form>
  `);

  document.getElementById('add-role-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await invoke('create_role', {
        data: {
          company: document.getElementById('new-company').value,
          title: document.getElementById('new-title').value,
          url: document.getElementById('new-url').value || null,
          jd_content: document.getElementById('new-jd').value || null,
          notes: null,
        }
      });
      closeModal();
      toast('Role added', 'success');
      renderRoles(document.getElementById('view-container'));
    } catch (err) {
      toast(err.toString(), 'error');
    }
  });
}

// ── Role Detail ──

// Tracks which content tabs are in edit mode. Reset on navigation.
let editingTabs = new Set();
// Tracks whether header is in edit mode.
let editingHeader = false;
// Which content tab is currently visible.
let activeContentTab = 'jd';

export async function renderRoleDetail(container, id) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading role...</div>';

  // Re-render when an ACP/direct-API tool mutates this role.
  subscribeDataChanged((payload) => {
    if (payload.scope === 'role' && payload.role_id === id) {
      renderRoleDetail(container, id);
    }
  });

  let role;
  try {
    role = await invoke('get_role', { id });
  } catch {
    container.innerHTML = '<div class="empty-state"><p>Role not found</p></div>';
    return;
  }

  const roleTasks = await invoke('list_tasks', { status: null, roleId: id });
  const wasAnalyzing = analyzingRoles.has(id);

  container.innerHTML = `
    <div>
      <a href="#/roles" class="text-muted text-sm" style="text-decoration:none">&larr; Back to Roles</a>
      <div id="role-header-wrap"></div>
    </div>

    <div id="analysis-status" class="analysis-status ${analyzingRoles.has(id) ? 'analysis-running' : 'hidden'}"></div>

    ${role.status === 'active' ? `
      <div class="card mb-16">
        <h4>Stage</h4>
        <div class="stage-select">
          ${STAGES.map(s => `
            <button class="stage-option ${s === role.stage ? 'current' : ''}" data-stage="${s}">${s}</button>
          `).join('')}
          <span style="margin:0 4px;color:var(--text-muted)">|</span>
          ${OUTCOMES.map(o => `
            <button class="stage-option" data-outcome="${o}" style="color:var(--red)">${o}</button>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="tabs" id="detail-tabs">
      ${CONTENT_FIELDS.map(f => `
        <button class="tab ${activeContentTab === f.key ? 'active' : ''}" data-detail-tab="${f.key}">${f.label}</button>
      `).join('')}
      <button class="tab ${activeContentTab === 'notes' ? 'active' : ''}" data-detail-tab="notes">Notes</button>
      <button class="tab ${activeContentTab === 'tasks' ? 'active' : ''}" data-detail-tab="tasks">Tasks (${roleTasks.length})</button>
    </div>

    ${CONTENT_FIELDS.map(f => `
      <div id="detail-${f.key}" class="tab-content ${activeContentTab === f.key ? 'active' : ''}"></div>
    `).join('')}

    <div id="detail-notes" class="tab-content ${activeContentTab === 'notes' ? 'active' : ''}">
      <div class="card">
        <div class="card-header">
          <h4>Notes</h4>
          <button class="btn btn-sm" id="btn-save-notes">Save</button>
        </div>
        <textarea id="role-notes" style="min-height:240px">${escapeHtml(role.notes) || ''}</textarea>
      </div>
    </div>

    <div id="detail-tasks" class="tab-content ${activeContentTab === 'tasks' ? 'active' : ''}">
      <div class="card">
        <div class="card-header">
          <h4>Tasks</h4>
          <button class="btn btn-sm" id="btn-add-role-task">+ Add Task</button>
        </div>
        ${roleTasks.length > 0 ? `
          <table>
            <tbody>
              ${roleTasks.map(t => `
                <tr>
                  <td style="width:30px">
                    <input type="checkbox" ${t.status === 'completed' ? 'checked' : ''} data-task-id="${t.id}" class="task-checkbox" />
                  </td>
                  <td style="${t.status === 'completed' ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${escapeHtml(t.content)}</td>
                  <td class="text-muted text-sm">${t.due_date ? formatDate(t.due_date) : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<p class="text-muted text-sm">No tasks for this role</p>'}
      </div>
    </div>
  `;

  renderRoleHeader(role);
  CONTENT_FIELDS.forEach(f => renderContentTab(role, f));

  if (wasAnalyzing) {
    setAnalysisBanner('running', 'Analyzing JD — generating analysis + fit score…');
  }

  // Tab switching
  container.querySelectorAll('[data-detail-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      activeContentTab = tab.dataset.detailTab;
      container.querySelectorAll('[data-detail-tab]').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`detail-${activeContentTab}`).classList.add('active');
    });
  });

  // Stage change (active → another active)
  container.querySelectorAll('.stage-option[data-stage]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await invoke('update_stage', { id, stage: btn.dataset.stage });
        toast(`Stage updated to ${btn.dataset.stage}`, 'success');
        renderRoleDetail(container, id);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  // Outcome (close role)
  container.querySelectorAll('.stage-option[data-outcome]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Close this role as "${btn.dataset.outcome}"?`)) return;
      try {
        await invoke('update_stage', { id, stage: btn.dataset.outcome });
        toast(`Role closed: ${btn.dataset.outcome}`, 'success');
        renderRoleDetail(container, id);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  // Save notes
  document.getElementById('btn-save-notes').addEventListener('click', async () => {
    try {
      await invoke('update_role', { id, data: { notes: document.getElementById('role-notes').value } });
      toast('Notes saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Task checkboxes
  container.querySelectorAll('.task-checkbox').forEach(cb => {
    cb.addEventListener('change', async () => {
      try {
        await invoke('update_task', {
          id: cb.dataset.taskId,
          data: { completed: cb.checked },
        });
        renderRoleDetail(container, id);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  // Add task
  document.getElementById('btn-add-role-task')?.addEventListener('click', () => {
    showModal(`
      <h3>Add Task for ${escapeHtml(role.company)}</h3>
      <form id="add-role-task-form">
        <div class="form-group"><label>Task</label>
          <input type="text" id="new-task-content" required placeholder="What needs to be done?" />
        </div>
        <div class="form-group"><label>Due Date (optional)</label>
          <input type="date" id="new-task-due" />
        </div>
        <div class="btn-group mt-16">
          <button type="submit" class="btn btn-primary">Add</button>
          <button type="button" class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
        </div>
      </form>
    `);
    document.getElementById('add-role-task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await invoke('create_task', {
          data: {
            content: document.getElementById('new-task-content').value,
            due_date: document.getElementById('new-task-due').value || null,
            role_id: id,
          }
        });
        closeModal();
        toast('Task added', 'success');
        renderRoleDetail(container, id);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });
}

function renderRoleHeader(role) {
  const wrap = document.getElementById('role-header-wrap');

  if (editingHeader) {
    wrap.innerHTML = `
      <div class="card mb-16">
        <h4>Edit Role</h4>
        <div class="form-group"><label>Company</label>
          <input type="text" id="edit-company" value="${escapeHtml(role.company)}" required />
        </div>
        <div class="form-group"><label>Title</label>
          <input type="text" id="edit-title" value="${escapeHtml(role.title)}" required />
        </div>
        <div class="form-group"><label>Job URL</label>
          <input type="url" id="edit-url" value="${escapeHtml(role.url) || ''}" placeholder="https://..." />
        </div>
        <div class="form-group"><label>Fit Score (0-100)</label>
          <input type="number" id="edit-fit" value="${role.fit_score || ''}" min="0" max="100" />
        </div>
        <div class="btn-group">
          <button class="btn btn-primary btn-sm" id="btn-save-header">Save</button>
          <button class="btn btn-sm" id="btn-cancel-header">Cancel</button>
        </div>
      </div>
    `;
    document.getElementById('btn-save-header').addEventListener('click', async () => {
      try {
        const fit = document.getElementById('edit-fit').value;
        await invoke('update_role', {
          id: role.id,
          data: {
            company: document.getElementById('edit-company').value,
            title: document.getElementById('edit-title').value,
            url: document.getElementById('edit-url').value || null,
            fit_score: fit ? parseInt(fit, 10) : null,
          }
        });
        editingHeader = false;
        toast('Role updated', 'success');
        renderRoleDetail(document.getElementById('view-container'), role.id);
      } catch (err) { toast(err.toString(), 'error'); }
    });
    document.getElementById('btn-cancel-header').addEventListener('click', () => {
      editingHeader = false;
      renderRoleHeader(role);
    });
    return;
  }

  wrap.innerHTML = `
    <div class="detail-header">
      <div>
        <h2 class="detail-title">${escapeHtml(role.company)} — ${escapeHtml(role.title)}</h2>
        <div class="detail-subtitle">
          <span class="badge ${stageBadgeClass(role.stage)}">${escapeHtml(role.stage)}</span>
          ${role.fit_score ? `<span class="fit-score ${fitScoreClass(role.fit_score)} ml-8">${role.fit_score}</span>` : ''}
          ${role.status !== 'active' && role.outcome ? `<span class="badge badge-${role.outcome.toLowerCase()} ml-8">${escapeHtml(role.outcome)}</span>` : ''}
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-primary btn-sm" id="btn-open-chat">Chat</button>
        ${role.status === 'active' ? `
          <button class="btn btn-sm" id="btn-tailor" ${!role.jd_content ? 'disabled title="Add a JD first"' : ''}>Tailor Resume</button>
          <button class="btn btn-sm" id="btn-research">Research</button>
        ` : ''}
        <button class="btn btn-sm" id="btn-edit-header">Edit</button>
        <button class="btn btn-danger btn-sm" id="btn-delete-role">Delete</button>
      </div>
    </div>

    <div class="detail-meta">
      ${role.url ? `<a href="${escapeHtml(role.url)}" target="_blank" class="meta-item" style="color:var(--accent)">Job Posting &nearr;</a>` : ''}
      <span class="meta-item">Added: ${formatDate(role.added_date)}</span>
      <span class="meta-item">Updated: ${formatDate(role.updated_date)}</span>
      ${role.closed_date ? `<span class="meta-item">Closed: ${formatDate(role.closed_date)}</span>` : ''}
    </div>
  `;

  document.getElementById('btn-edit-header').addEventListener('click', () => {
    editingHeader = true;
    renderRoleHeader(role);
  });

  document.getElementById('btn-open-chat').addEventListener('click', () => {
    openChat(role);
  });

  document.getElementById('btn-tailor')?.addEventListener('click', () => {
    openChatAndSend(role, 'Tailor my resume for this role. Save the draft with save_artifact(kind: "resume"), save the fit analysis with save_artifact(kind: "analysis"), and update the fit score.');
  });

  document.getElementById('btn-research')?.addEventListener('click', () => {
    openChatAndSend(role, 'Generate a research packet for this company and role — company overview, likely interview questions (technical, behavioral, system design), and questions I should ask. Save it with save_artifact(kind: "research").');
  });

  document.getElementById('btn-delete-role').addEventListener('click', async () => {
    if (!confirm('Delete this role? This cannot be undone.')) return;
    try {
      await invoke('delete_role', { id: role.id });
      toast('Role deleted', 'success');
      navigate('#/roles');
    } catch (err) { toast(err.toString(), 'error'); }
  });
}

function renderContentTab(role, field) {
  const el = document.getElementById(`detail-${field.key}`);
  const value = role[field.field];
  const editing = editingTabs.has(field.key);

  if (editing) {
    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h4>${field.label}</h4>
          <div class="btn-group">
            <button class="btn btn-primary btn-sm" data-save="${field.key}">Save</button>
            <button class="btn btn-sm" data-cancel="${field.key}">Cancel</button>
          </div>
        </div>
        <textarea data-edit="${field.key}" style="min-height:340px" placeholder="${escapeHtml(field.placeholder)}">${escapeHtml(value) || ''}</textarea>
      </div>
    `;

    el.querySelector(`[data-save="${field.key}"]`).addEventListener('click', async () => {
      const newValue = el.querySelector(`[data-edit="${field.key}"]`).value;
      const prev = value || '';
      try {
        await invoke('update_role', { id: role.id, data: { [field.field]: newValue } });
        editingTabs.delete(field.key);
        toast(`${field.label} saved`, 'success');
        // Re-fetch fresh role so render reflects saved value.
        const fresh = await invoke('get_role', { id: role.id });
        renderContentTab(fresh, field);

        // JD changed → auto-generate analysis + fit score in the background.
        if (field.key === 'jd' && newValue.trim() && newValue.trim() !== prev.trim()) {
          autoAnalyzeRole(role.id);
        }
      } catch (err) { toast(err.toString(), 'error'); }
    });

    el.querySelector(`[data-cancel="${field.key}"]`).addEventListener('click', () => {
      editingTabs.delete(field.key);
      renderContentTab(role, field);
    });
    return;
  }

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h4>${field.label}</h4>
        <button class="btn btn-sm" data-edit-btn="${field.key}">${value ? 'Edit' : 'Add'}</button>
      </div>
      ${value
        ? `<div class="markdown-content">${renderMarkdown(value)}</div>`
        : `<div class="empty-state"><p>${escapeHtml(field.empty)}</p></div>`
      }
    </div>
  `;

  el.querySelector(`[data-edit-btn="${field.key}"]`).addEventListener('click', () => {
    editingTabs.add(field.key);
    renderContentTab(role, field);
  });
}
