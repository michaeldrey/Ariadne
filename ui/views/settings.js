import { invoke, escapeHtml, toast, showModal, closeModal, renderMarkdown } from '../app.js';

// Parse markdown work stories into [{title, situation, task, action, result}]
// Expects `## Title` headers with `**Section:**` labeled blocks beneath.
function parseStories(md) {
  if (!md) return [];
  const stories = [];
  const blocks = md.split(/^##\s+/m).slice(1); // first slice is pre-header preamble
  for (const block of blocks) {
    const firstNL = block.indexOf('\n');
    const title = (firstNL === -1 ? block : block.slice(0, firstNL)).trim();
    const body = firstNL === -1 ? '' : block.slice(firstNL + 1);
    const section = (label) => {
      const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*\\w+:\\*\\*|$)`, 'i');
      const m = body.match(re);
      return m ? m[1].trim() : '';
    };
    stories.push({
      title,
      situation: section('Situation'),
      task: section('Task'),
      action: section('Action'),
      result: section('Result'),
    });
  }
  return stories;
}

let editingStories = false;

export async function renderSettings(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading settings...</div>';

  const settings = await invoke('get_settings');

  container.innerHTML = `
    <h2>Settings</h2>

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
        <p class="text-muted text-sm mt-8">Required for resume tailoring and research packet generation</p>
      </div>
    </div>

    <div class="card mb-16">
      <h3>Job Search Backend</h3>
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
      <h3>Profile</h3>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="profile-name" value="${escapeHtml(settings.profile_name) || ''}" placeholder="Your name" />
      </div>
      <div class="form-group">
        <label>Resume PDF Filename</label>
        <input type="text" id="resume-filename" value="${escapeHtml(settings.resume_filename) || 'Resume.pdf'}" placeholder="Resume.pdf" />
      </div>
      <div class="form-group">
        <label>Profile (markdown)</label>
        <textarea id="profile-md" placeholder="Background, target roles, compensation goals…" style="min-height:140px">${escapeHtml(settings.profile_json) || ''}</textarea>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-profile">Save Profile</button>
    </div>

    <div class="card mb-16">
      <h3>Search Criteria</h3>
      <p class="text-muted text-sm mb-8">Used by Claude when helping you evaluate roles or search.</p>
      <textarea id="search-criteria" placeholder="Target companies, excluded companies, must-haves, dealbreakers…" style="min-height:160px">${escapeHtml(settings.search_criteria) || ''}</textarea>
      <button class="btn btn-sm btn-primary mt-16" id="btn-save-search-criteria">Save Search Criteria</button>
    </div>

    <div class="card mb-16">
      <h3>Resume Content</h3>
      <p class="text-muted text-sm mb-8">Your master resume in markdown. Used as the source for all tailored resumes.</p>
      <textarea id="resume-content" style="min-height:200px">${escapeHtml(settings.resume_content) || ''}</textarea>
      <button class="btn btn-sm btn-primary mt-16" id="btn-save-resume">Save Resume</button>
    </div>

    <div class="card mb-16">
      <div class="card-header">
        <h3>Work Stories (STAR)</h3>
        <button class="btn btn-sm ${editingStories ? 'btn-primary' : ''}" id="btn-toggle-stories-edit">${editingStories ? 'Save & View' : 'Edit Markdown'}</button>
      </div>
      <p class="text-muted text-sm mb-16">Interview stories referenced during resume tailoring. Format: <code>## Title</code> then <code>**Situation:**</code>, <code>**Task:**</code>, <code>**Action:**</code>, <code>**Result:**</code> blocks.</p>
      <div id="stories-body"></div>
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

  // Save profile
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    try {
      await invoke('update_settings', {
        data: {
          profile_name: document.getElementById('profile-name').value || null,
          resume_filename: document.getElementById('resume-filename').value || null,
          profile_json: document.getElementById('profile-md').value || null,
        }
      });
      toast('Profile saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Save search criteria
  document.getElementById('btn-save-search-criteria').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { search_criteria: document.getElementById('search-criteria').value || null } });
      toast('Search criteria saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Save resume
  document.getElementById('btn-save-resume').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { resume_content: document.getElementById('resume-content').value } });
      toast('Resume saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Stories: render body & wire up toggle
  renderStoriesBody(settings.work_stories || '');

  document.getElementById('btn-toggle-stories-edit').addEventListener('click', async () => {
    if (editingStories) {
      // Currently editing → save and switch to view
      const value = document.getElementById('work-stories').value;
      try {
        await invoke('update_settings', { data: { work_stories: value } });
        toast('Work stories saved', 'success');
        editingStories = false;
        renderSettings(container);
      } catch (err) { toast(err.toString(), 'error'); }
    } else {
      editingStories = true;
      renderSettings(container);
    }
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
      <code>profile.md</code>, <code>search-criteria.md</code> into Settings fields
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

function renderStoriesBody(md) {
  const el = document.getElementById('stories-body');

  if (editingStories) {
    el.innerHTML = `
      <textarea id="work-stories" style="min-height:360px" placeholder="## My Story Title

**Situation:** ...

**Task:** ...

**Action:** ...

**Result:** ...">${escapeHtml(md)}</textarea>
    `;
    return;
  }

  const stories = parseStories(md);
  if (stories.length === 0) {
    el.innerHTML = `<div class="empty-state"><p>No stories yet. Click "Edit Markdown" to add some.</p></div>`;
    return;
  }

  el.innerHTML = stories.map((s, i) => {
    const preview = (s.result || s.action || s.situation || '').slice(0, 150);
    return `
      <div class="story-card" data-story-idx="${i}">
        <div class="story-header">
          <div>
            <div class="story-title">${escapeHtml(s.title)}</div>
            <div class="story-preview">${escapeHtml(preview)}${preview.length >= 150 ? '…' : ''}</div>
          </div>
          <button class="btn btn-sm" data-toggle-story="${i}">Expand</button>
        </div>
        <div class="story-body hidden" data-story-body="${i}">
          ${['situation', 'task', 'action', 'result'].map(key => s[key] ? `
            <div class="story-section">
              <div class="story-label">${key}</div>
              <div class="markdown-content">${renderMarkdown(s[key])}</div>
            </div>
          ` : '').join('')}
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('[data-toggle-story]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = btn.dataset.toggleStory;
      const body = el.querySelector(`[data-story-body="${i}"]`);
      const expanded = !body.classList.contains('hidden');
      body.classList.toggle('hidden', expanded);
      btn.textContent = expanded ? 'Expand' : 'Collapse';
    });
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
