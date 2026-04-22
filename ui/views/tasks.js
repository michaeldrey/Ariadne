import { invoke, escapeHtml, formatDate, toast, showModal, closeModal } from '../app.js';

export async function renderTasks(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading tasks...</div>';

  const allTasks = await invoke('list_tasks', { status: null, roleId: null });
  const pending = allTasks.filter(t => t.status === 'pending');
  const completed = allTasks.filter(t => t.status === 'completed');

  // Overdue detection
  const today = new Date().toISOString().slice(0, 10);

  container.innerHTML = `
    <div class="flex-between mb-16">
      <h2>Tasks</h2>
      <button class="btn btn-primary" id="btn-add-task">+ Add Task</button>
    </div>

    <div class="card mb-16">
      <h3>Pending (${pending.length})</h3>
      ${pending.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th style="width:30px"></th>
              <th>Task</th>
              <th>Linked To</th>
              <th>Due</th>
              <th style="width:40px"></th>
            </tr>
          </thead>
          <tbody>
            ${pending.map(t => {
              const overdue = t.due_date && t.due_date < today;
              return `
                <tr>
                  <td><input type="checkbox" class="task-check" data-id="${t.id}" /></td>
                  <td ${overdue ? 'style="color:var(--red)"' : ''}>${escapeHtml(t.content)}</td>
                  <td class="text-sm text-muted">${t.role_label ? escapeHtml(t.role_label) : '—'}</td>
                  <td class="text-sm ${overdue ? 'mono' : 'text-muted'}" ${overdue ? 'style="color:var(--red)"' : ''}>
                    ${t.due_date ? formatDate(t.due_date) : '—'}
                    ${overdue ? ' (overdue)' : ''}
                  </td>
                  <td><button class="btn-icon task-delete" data-id="${t.id}" title="Delete">&times;</button></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      ` : '<div class="empty-state"><p>No pending tasks</p></div>'}
    </div>

    ${completed.length > 0 ? `
      <div class="card">
        <h3>Recently Completed (${completed.length})</h3>
        <table>
          <tbody>
            ${completed.slice(0, 10).map(t => `
              <tr>
                <td style="width:30px"><input type="checkbox" checked class="task-uncheck" data-id="${t.id}" /></td>
                <td style="text-decoration:line-through;color:var(--text-muted)">${escapeHtml(t.content)}</td>
                <td class="text-sm text-muted">${t.role_label ? escapeHtml(t.role_label) : ''}</td>
                <td class="text-sm text-muted">${formatDate(t.completed_at)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}
  `;

  // Check/uncheck handlers
  container.querySelectorAll('.task-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      try {
        await invoke('complete_task', { id: cb.dataset.id });
        toast('Task completed', 'success');
        renderTasks(container);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  container.querySelectorAll('.task-uncheck').forEach(cb => {
    cb.addEventListener('change', async () => {
      try {
        await invoke('update_task', { id: cb.dataset.id, data: { completed: false } });
        renderTasks(container);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  // Delete
  container.querySelectorAll('.task-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await invoke('delete_task', { id: btn.dataset.id });
        toast('Task deleted', 'success');
        renderTasks(container);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  // Add task
  document.getElementById('btn-add-task').addEventListener('click', async () => {
    const roles = await invoke('list_roles', { status: 'active' });

    showModal(`
      <h3>Add Task</h3>
      <form id="add-task-form">
        <div class="form-group">
          <label>Task</label>
          <input type="text" id="task-content" required placeholder="What needs to be done?" />
        </div>
        <div class="form-group">
          <label>Due Date (optional)</label>
          <input type="date" id="task-due" />
        </div>
        <div class="form-group">
          <label>Linked Role (optional)</label>
          <select id="task-role">
            <option value="">None</option>
            ${roles.map(r => `<option value="${r.id}">${escapeHtml(r.company)} — ${escapeHtml(r.title)}</option>`).join('')}
          </select>
        </div>
        <div class="btn-group mt-16">
          <button type="submit" class="btn btn-primary">Add Task</button>
          <button type="button" class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
        </div>
      </form>
    `);

    document.getElementById('add-task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await invoke('create_task', {
          data: {
            content: document.getElementById('task-content').value,
            due_date: document.getElementById('task-due').value || null,
            role_id: document.getElementById('task-role').value || null,
          }
        });
        closeModal();
        toast('Task added', 'success');
        renderTasks(container);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });
}
