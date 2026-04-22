import { invoke, escapeHtml, formatDate, stageBadgeClass, fitScoreClass, toast } from '../app.js';

const STAGES = ['Sourced', 'Applied', 'Recruiter Screen', 'HM Interview', 'Onsite', 'Offer', 'Negotiating'];
const OUTCOMES = ['Rejected', 'Withdrew', 'Accepted', 'Expired'];

// Module-local sort state (persists across re-renders within this session).
let sortKey = 'updated_date';
let sortDir = 'desc';
let stageFilter = null;
let closedExpanded = false;

export async function renderDashboard(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading dashboard...</div>';

  const [allRoles, settings, allTasks, recentChats] = await Promise.all([
    invoke('list_roles', { status: null }),
    invoke('get_settings'),
    invoke('list_tasks', { status: null, roleId: null }),
    invoke('list_recent_conversations', { limit: 5 }),
  ]);
  const active = allRoles.filter(r => r.status === 'active');
  const closed = allRoles.filter(r => r.status === 'closed');

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekStr = weekAgo.toISOString().slice(0, 10);

  // "This Week" signals, ranked by action-worthiness.
  const tasksDue = allTasks.filter(t =>
    t.status === 'pending' && t.due_date && t.due_date <= today
  );
  const stalledRoles = active.filter(r => r.updated_date < weekStr);
  const upcomingInterviews = active.filter(r =>
    ['Recruiter Screen', 'HM Interview', 'Onsite', 'Offer', 'Negotiating'].includes(r.stage)
  );

  const stageCounts = {};
  STAGES.forEach(s => stageCounts[s] = 0);
  active.forEach(r => { if (stageCounts[r.stage] !== undefined) stageCounts[r.stage]++; });

  const checklist = buildSetupChecklist(settings, allRoles.length);
  const showWelcome = checklist.some(item => !item.done);

  container.innerHTML = `
    <h2>Dashboard</h2>

    ${showWelcome ? renderWelcomeCard(checklist) : ''}

    ${renderThisWeekBand(tasksDue, stalledRoles, upcomingInterviews)}

    <div class="pipeline" id="pipeline">
      ${STAGES.map((stage, i) => `
        <div class="pipeline-stage ${stage === stageFilter ? 'active' : ''} ${stageCounts[stage] === 0 ? 'disabled' : ''}"
             data-stage="${stage}">
          <div class="count">${stageCounts[stage]}</div>
          <div class="label">${stage}</div>
        </div>
        ${i < STAGES.length - 1 ? '<div class="pipeline-arrow">→</div>' : ''}
      `).join('')}
    </div>

    ${renderRecentChatsCard(recentChats)}

    <div class="card">
      <div class="card-header">
        <h3>Active Roles ${stageFilter ? `<span class="text-muted text-sm">— ${escapeHtml(stageFilter)}</span>` : ''}</h3>
        <div class="btn-group">
          ${stageFilter ? `<button class="btn btn-sm" id="btn-clear-filter">Clear Filter</button>` : ''}
          <button class="btn btn-sm btn-primary" onclick="window.location.hash='#/roles'">Manage All</button>
        </div>
      </div>
      <div id="active-roles-table"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Closed / Rejected (${closed.length})</h3>
        <button class="btn btn-sm" id="btn-toggle-closed" aria-expanded="${closedExpanded}">
          ${closedExpanded ? '− Hide' : '+ Show'}
        </button>
      </div>
      <div id="closed-roles-table" class="${closedExpanded ? '' : 'hidden'}"></div>
    </div>
  `;

  renderActiveTable(active);
  renderClosedTable(closed);
  wirePipeline(container, active, closed);
}

function renderActiveTable(active) {
  const rows = stageFilter ? active.filter(r => r.stage === stageFilter) : active;
  const sorted = sortRows(rows, sortKey, sortDir);
  const el = document.getElementById('active-roles-table');

  if (sorted.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No roles in this view</p></div>';
    return;
  }

  el.innerHTML = `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            ${sortHeader('company', 'Company')}
            <th>Role</th>
            ${sortHeader('fit_score', 'Fit')}
            ${sortHeader('stage', 'Stage')}
            <th>Next Action</th>
            ${sortHeader('updated_date', 'Updated')}
          </tr>
        </thead>
        <tbody>
          ${sorted.map(r => roleRow(r)).join('')}
        </tbody>
      </table>
    </div>
  `;

  wireSortHeaders(el, () => renderActiveTable(active));
  wireRowNav(el);
  wireStageDropdowns(el, () => {
    // After stage change, re-fetch and re-render to reflect new pipeline counts.
    const container = document.getElementById('view-container');
    renderDashboard(container);
  });
}

function renderClosedTable(closed) {
  const el = document.getElementById('closed-roles-table');
  if (closed.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No closed roles</p></div>';
    return;
  }

  const sorted = [...closed].sort((a, b) => (b.closed_date || '').localeCompare(a.closed_date || ''));

  el.innerHTML = `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Role</th>
            <th>Stage Reached</th>
            <th>Outcome</th>
            <th>Closed</th>
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

function renderFitScoreCellInline(score) {
  if (!score) return '—';
  const cls = fitScoreClass(score);
  const pct = Math.max(0, Math.min(100, score));
  return `
    <span class="fit-score-cell ${cls}" title="Fit score ${score}">
      <span class="fit-score-num">${score}</span>
      <span class="fit-score-bar"><span class="fit-score-bar-fill" style="width:${pct}%"></span></span>
    </span>
  `;
}

function renderThisWeekBand(tasksDue, stalled, interviews) {
  // Action-oriented replacement for the old KPI grid. Shows only bands that
  // have content so the dashboard doesn't shout empty zeros at you on day one.
  const blocks = [];
  if (tasksDue.length) {
    const preview = tasksDue.slice(0, 3).map(t => escapeHtml(t.content)).join(', ');
    const more = tasksDue.length > 3 ? ` +${tasksDue.length - 3} more` : '';
    blocks.push({
      cls: 'this-week-block due',
      label: `${tasksDue.length} task${tasksDue.length === 1 ? '' : 's'} due`,
      detail: `${preview}${more}`,
      href: '#/tasks',
    });
  }
  if (interviews.length) {
    const preview = interviews.slice(0, 3).map(r => escapeHtml(`${r.company} (${r.stage})`)).join(', ');
    const more = interviews.length > 3 ? ` +${interviews.length - 3} more` : '';
    blocks.push({
      cls: 'this-week-block interview',
      label: `${interviews.length} interview${interviews.length === 1 ? '' : 's'} in flight`,
      detail: `${preview}${more}`,
      href: '#/roles',
    });
  }
  if (stalled.length) {
    const preview = stalled.slice(0, 3).map(r => escapeHtml(`${r.company}`)).join(', ');
    const more = stalled.length > 3 ? ` +${stalled.length - 3} more` : '';
    blocks.push({
      cls: 'this-week-block stalled',
      label: `${stalled.length} stalled role${stalled.length === 1 ? '' : 's'} (>7 days)`,
      detail: `${preview}${more}`,
      href: '#/roles',
    });
  }

  if (blocks.length === 0) {
    return `
      <div class="this-week-empty text-muted text-sm">
        Nothing urgent. No tasks due, no interviews in flight, nothing stalled.
      </div>
    `;
  }

  return `
    <div class="this-week-grid">
      ${blocks.map(b => `
        <a class="${b.cls}" href="${b.href}">
          <div class="this-week-label">${b.label}</div>
          <div class="this-week-detail">${b.detail}</div>
        </a>
      `).join('')}
    </div>
  `;
}

function renderRecentChatsCard(recent) {
  if (!recent || recent.length === 0) return '';
  return `
    <div class="card">
      <div class="card-header">
        <h3>Recent Chats</h3>
      </div>
      <div class="recent-chats">
        ${recent.map(c => {
          const scopeLabel = c.scope_type === 'role'
            ? (c.role_company ? `${escapeHtml(c.role_company)} — ${escapeHtml(c.role_title || '')}` : 'Role chat')
            : 'Profile';
          const title = c.title ? escapeHtml(c.title) : '<span class="text-muted">(untitled)</span>';
          const href = c.scope_type === 'role' && c.role_id ? `#/roles/${c.role_id}` : '#/profile';
          return `
            <a class="recent-chat-item" href="${href}">
              <div class="recent-chat-title">${title}</div>
              <div class="recent-chat-meta text-muted text-sm">${escapeHtml(scopeLabel)} · ${formatDate(c.updated_at)}</div>
            </a>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function roleRow(r) {
  return `
    <tr data-href="#/roles/${r.id}">
      <td><strong>${escapeHtml(r.company)}</strong></td>
      <td>${escapeHtml(r.title)}</td>
      <td>${renderFitScoreCellInline(r.fit_score)}</td>
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

function sortHeader(key, label) {
  const indicator = sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
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
    return String(a.company || '').localeCompare(String(b.company || ''));
  });
}

function wireSortHeaders(scope, rerender) {
  scope.querySelectorAll('th[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = 'asc';
      }
      rerender();
    });
  });
}

function wireRowNav(scope) {
  scope.querySelectorAll('tr[data-href]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      // Don't navigate if the user clicked a form control inside the row.
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

function buildSetupChecklist(settings, roleCount) {
  const has = (v) => typeof v === 'string' && v.trim().length > 0;
  return [
    { key: 'api', label: 'Add your Anthropic API key', href: '#/settings',   done: has(settings?.anthropic_api_key) },
    { key: 'name', label: 'Set your name',              href: '#/profile',   done: has(settings?.profile_name) },
    { key: 'resume', label: 'Paste your master resume', href: '#/profile',   done: has(settings?.resume_content) },
    { key: 'stories', label: 'Generate work stories',   href: '#/profile',   done: has(settings?.work_stories) },
    { key: 'role',  label: 'Add your first role',       href: '#/roles',     done: roleCount > 0 },
  ];
}

function renderWelcomeCard(checklist) {
  const done = checklist.filter(i => i.done).length;
  const total = checklist.length;
  return `
    <div class="card welcome-card mb-16">
      <div class="card-header">
        <h3>Getting Started · ${done}/${total}</h3>
        <span class="text-muted text-sm">This card disappears when everything's set.</span>
      </div>
      <ul class="checklist">
        ${checklist.map(item => `
          <li class="${item.done ? 'done' : ''}">
            <span class="check">${item.done ? '✓' : '○'}</span>
            ${item.done
              ? `<span>${escapeHtml(item.label)}</span>`
              : `<a href="${item.href}">${escapeHtml(item.label)}</a>`
            }
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

function wirePipeline(container, active, closed) {
  container.querySelectorAll('.pipeline-stage').forEach(el => {
    el.addEventListener('click', () => {
      const stage = el.dataset.stage;
      if (el.classList.contains('disabled')) return;
      stageFilter = (stageFilter === stage) ? null : stage;
      // Re-render dashboard to reflect filter in pipeline UI.
      const c = document.getElementById('view-container');
      renderDashboard(c);
    });
  });

  document.getElementById('btn-clear-filter')?.addEventListener('click', () => {
    stageFilter = null;
    const c = document.getElementById('view-container');
    renderDashboard(c);
  });

  document.getElementById('btn-toggle-closed')?.addEventListener('click', () => {
    closedExpanded = !closedExpanded;
    const tableEl = document.getElementById('closed-roles-table');
    const btnEl = document.getElementById('btn-toggle-closed');
    tableEl.classList.toggle('hidden', !closedExpanded);
    btnEl.textContent = closedExpanded ? '− Hide' : '+ Show';
    btnEl.setAttribute('aria-expanded', String(closedExpanded));
  });
}
