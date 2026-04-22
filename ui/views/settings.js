import { invoke, escapeHtml, toast, showModal, closeModal } from '../app.js';

export async function renderSettings(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading settings...</div>';

  const settings = await invoke('get_settings');

  container.innerHTML = `
    <h2>Settings</h2>
    <p class="text-muted text-sm mb-16">App configuration. Your personal content lives under <a href="#/profile" style="color:var(--accent)">Profile</a>.</p>

    <div class="card mb-16">
      <h3>API Keys</h3>
      <div class="form-group">
        <label>Anthropic API Key</label>
        <div class="flex gap-8">
          <input type="password" id="anthropic-key" value="${settings.anthropic_api_key || ''}"
                 placeholder="sk-ant-..." style="flex:1" />
          <button class="btn btn-sm" id="btn-save-anthropic">Save</button>
          ${settings.anthropic_api_key ? '<button class="btn btn-sm btn-danger" id="btn-clear-anthropic">Clear</button>' : ''}
        </div>
        <p class="text-muted text-sm mt-8">Required for resume tailoring, research, and chat. Get one at <code>console.anthropic.com</code>.</p>
      </div>
    </div>

    <div class="card mb-16">
      <h3>Job Search Backend</h3>
      <p class="text-muted text-sm mb-8">Ariadne ships open-source without a built-in search backend. Plug your own in here, or skip and add roles manually.</p>
      <div class="form-group">
        <label>Search Backend</label>
        <select id="search-backend">
          <option value="jobbot" ${settings.search_backend === 'jobbot' ? 'selected' : ''}>JobBot API</option>
          <option value="none" ${!settings.search_backend || settings.search_backend === 'none' ? 'selected' : ''}>None (manual only)</option>
        </select>
      </div>
      <div class="form-group">
        <label>JobBot Endpoint</label>
        <input type="url" id="jobbot-endpoint" value="${settings.jobbot_endpoint || ''}" placeholder="https://..." />
      </div>
      <div class="form-group">
        <label>JobBot API Key</label>
        <input type="password" id="jobbot-key" value="${settings.jobbot_api_key || ''}" placeholder="API key" />
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-search">Save Search Config</button>
    </div>

    <div class="card mb-16">
      <h3>Import Data</h3>
      <p class="text-muted text-sm mb-8">Import data from your existing Ariadne JSON files (tracker.json, network.json, tasks.json).</p>
      <div class="btn-group">
        <button class="btn btn-sm" id="btn-import-tracker">Import tracker.json</button>
        <button class="btn btn-sm" id="btn-import-contacts">Import network.json</button>
        <button class="btn btn-sm" id="btn-import-tasks">Import tasks.json</button>
      </div>
      <p class="text-muted text-sm mb-8 mt-16">Import from Ariadne2 — per-role JDs / resume drafts / analyses / notes from role folders, plus top-level resume, work stories, profile, and search criteria. Safe to re-run.</p>
      <button class="btn btn-sm" id="btn-import-role-folders">Import from Ariadne2</button>
    </div>
  `;

  // Save Anthropic key
  document.getElementById('btn-save-anthropic').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { anthropic_api_key: document.getElementById('anthropic-key').value } });
      toast('Anthropic API key saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Clear Anthropic key
  document.getElementById('btn-clear-anthropic')?.addEventListener('click', async () => {
    try {
      await invoke('clear_api_key');
      document.getElementById('anthropic-key').value = '';
      toast('API key cleared', 'success');
      renderSettings(container);
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Save search config
  document.getElementById('btn-save-search').addEventListener('click', async () => {
    try {
      await invoke('update_settings', {
        data: {
          search_backend: document.getElementById('search-backend').value,
          jobbot_endpoint: document.getElementById('jobbot-endpoint').value || null,
          jobbot_api_key: document.getElementById('jobbot-key').value || null,
        }
      });
      toast('Search config saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Import handlers
  document.getElementById('btn-import-tracker').addEventListener('click', () => showImportModal('tracker'));
  document.getElementById('btn-import-contacts').addEventListener('click', () => showImportModal('contacts'));
  document.getElementById('btn-import-tasks').addEventListener('click', () => showImportModal('tasks'));
  document.getElementById('btn-import-role-folders').addEventListener('click', showRoleFoldersImportModal);
}

function showRoleFoldersImportModal() {
  showModal(`
    <h3>Import from Ariadne2</h3>
    <p class="text-sm text-muted mb-16">
      Pulls everything from an Ariadne2 data directory:
      <br>• Per-role JDs / resume drafts / analyses / research / notes from
      <code>Applied</code>, <code>Closed</code>, <code>InProgress</code>,
      <code>Rejected</code> folders (matched by <code>"Company - Title"</code>).
      <br>• Top-level <code>resume-content.md</code>, <code>work-stories.md</code>,
      <code>profile.md</code>, <code>search-criteria.md</code> into Profile fields
      (only if currently empty).
      <br>Safe to re-run — nothing is overwritten or duplicated.
    </p>
    <div class="form-group">
      <label>Base directory</label>
      <input type="text" id="import-base-dir" value="~/Development/Ariadne2/Ariadne/data" style="font-family:var(--font-mono);font-size:12px" />
    </div>
    <div class="btn-group mt-16">
      <button class="btn btn-primary" id="btn-do-role-import">Import</button>
      <button class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
    </div>
    <div id="role-import-result" class="text-sm mt-16"></div>
  `);

  document.getElementById('btn-do-role-import').addEventListener('click', async () => {
    const baseDir = document.getElementById('import-base-dir').value.trim();
    if (!baseDir) { toast('Base directory required', 'error'); return; }

    const resultEl = document.getElementById('role-import-result');
    resultEl.innerHTML = '<div class="loading"><div class="spinner"></div> Importing…</div>';

    try {
      const r = await invoke('import_role_artifacts', { baseDir });
      const unmatchedList = r.unmatched.length > 0
        ? `<details class="mt-8"><summary class="text-muted">${r.unmatched.length} unmatched folders (click to expand)</summary><pre style="font-size:11px;color:var(--text-muted);white-space:pre-wrap;margin-top:8px">${r.unmatched.map(u => escapeHtml(u)).join('\n')}</pre></details>`
        : '';
      const profileList = (r.profile_files_imported || []).length > 0
        ? `<p><strong>${r.profile_files_imported.length}</strong> profile files imported: ${r.profile_files_imported.map(f => `<code>${escapeHtml(f)}</code>`).join(', ')}.</p>`
        : `<p class="text-muted">No new profile files imported (either missing from the base dir, or the target fields are already filled).</p>`;
      resultEl.innerHTML = `
        <div class="card">
          <p><strong>${r.matched}</strong> role folders matched.</p>
          <p><strong>${r.artifacts_created}</strong> artifacts (resume/analysis/research) imported.</p>
          <p><strong>${r.jd_updates}</strong> JDs set, <strong>${r.notes_updates}</strong> notes set (only on previously-empty fields).</p>
          ${profileList}
          ${unmatchedList}
        </div>
      `;
      toast(`Imported ${r.artifacts_created} artifacts + ${(r.profile_files_imported || []).length} profile files`, 'success');
    } catch (err) {
      resultEl.innerHTML = `<p style="color:var(--red)">${escapeHtml(err.toString())}</p>`;
      toast(err.toString(), 'error');
    }
  });
}

function showImportModal(type) {
  const labels = { tracker: 'tracker.json', contacts: 'network.json', tasks: 'tasks.json' };
  const commands = { tracker: 'import_tracker', contacts: 'import_contacts', tasks: 'import_tasks' };

  showModal(`
    <h3>Import ${labels[type]}</h3>
    <p class="text-sm text-muted mb-16">Paste the contents of your ${labels[type]} file below.</p>
    <div class="form-group">
      <textarea id="import-data" style="min-height:300px" placeholder='{"active": [...], ...}'></textarea>
    </div>
    <div class="btn-group mt-16">
      <button class="btn btn-primary" id="btn-do-import">Import</button>
      <button class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
    </div>
  `);

  document.getElementById('btn-do-import').addEventListener('click', async () => {
    const data = document.getElementById('import-data').value;
    if (!data.trim()) { toast('No data to import', 'error'); return; }

    try {
      const result = await invoke(commands[type], { jsonStr: data });
      closeModal();
      toast(`Imported ${result.imported} items (${result.skipped} skipped)`, 'success');
    } catch (err) {
      toast(err.toString(), 'error');
    }
  });
}
