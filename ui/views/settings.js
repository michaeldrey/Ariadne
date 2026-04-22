import { invoke, escapeHtml, toast } from '../app.js';

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
      <h3>Agent Backend</h3>
      <p class="text-muted text-sm mb-8">Which engine runs chat + tool calls. ACP (Agent Client Protocol) uses the Zed-maintained <code>claude-code-acp</code> adapter — multi-vendor pluggable and required for future features. Direct hits the Anthropic API directly and is scheduled for removal.</p>
      <div class="form-group">
        <label>Backend</label>
        <select id="agent-backend">
          <option value="direct" ${(settings.agent_backend || 'direct') === 'direct' ? 'selected' : ''}>Direct (Anthropic Messages API)</option>
          <option value="acp" ${settings.agent_backend === 'acp' ? 'selected' : ''}>ACP (claude-code-acp)</option>
        </select>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-backend">Save Backend</button>

      <div id="acp-install-status" class="text-sm mt-16 pt-8" style="border-top:1px solid var(--border)">
        <div class="text-muted">Checking <code>claude-code-acp</code> install…</div>
      </div>
    </div>

    <div class="card mb-16">
      <h3>Account & Sync</h3>
      <p class="text-muted text-sm mb-8">Ariadne is local-first — your data lives on this machine. Cloud sync across devices is planned but not yet available.</p>
      <button class="btn btn-sm" disabled title="Not yet available">Sign in</button>
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

  // Save agent backend
  document.getElementById('btn-save-backend').addEventListener('click', async () => {
    try {
      await invoke('update_settings', {
        data: { agent_backend: document.getElementById('agent-backend').value }
      });
      toast('Agent backend saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  renderAcpInstallStatus();

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

}

async function renderAcpInstallStatus() {
  const el = document.getElementById('acp-install-status');
  if (!el) return;
  let status;
  try {
    status = await invoke('detect_acp_install');
  } catch (err) {
    el.innerHTML = `<div style="color:var(--red)">Install detection failed: ${escapeHtml(err.toString())}</div>`;
    return;
  }

  if (status.installed) {
    const version = status.version ? ` v${escapeHtml(status.version)}` : '';
    el.innerHTML = `
      <div><strong>✓ claude-code-acp installed${version}</strong></div>
      <div class="text-muted" style="font-family:var(--font-mono);font-size:11px">${escapeHtml(status.path)}</div>
      <div class="text-muted mt-8">Fast cold starts — no npm registry lookup on launch.</div>
    `;
    return;
  }

  if (!status.npm_available) {
    el.innerHTML = `
      <div><strong>claude-code-acp not installed</strong></div>
      <div class="text-muted mt-8">Also, <code>npm</code> isn't on PATH. Install <a href="https://nodejs.org" target="_blank" style="color:var(--accent)">Node.js</a> first, then come back.</div>
      <div class="text-muted mt-8">Without the install, the ACP backend falls back to <code>npx -y @latest</code> on every launch (~1–30s slower).</div>
    `;
    return;
  }

  el.innerHTML = `
    <div><strong>claude-code-acp not installed globally</strong></div>
    <div class="text-muted mt-8">The ACP backend currently falls back to <code>npx -y @latest</code>, which adds ~1–30s to every cold start. Install once to skip that.</div>
    <button class="btn btn-sm btn-primary mt-8" id="btn-install-acp">Install claude-code-acp</button>
    <div id="acp-install-log" class="text-sm text-muted mt-8" style="font-family:var(--font-mono);font-size:11px;white-space:pre-wrap"></div>
  `;

  document.getElementById('btn-install-acp').addEventListener('click', async () => {
    const btn = document.getElementById('btn-install-acp');
    const log = document.getElementById('acp-install-log');
    btn.disabled = true;
    btn.textContent = 'Installing…';
    log.textContent = 'Running: npm install -g @zed-industries/claude-code-acp\n';
    try {
      const output = await invoke('install_acp');
      log.textContent += output;
      toast('claude-code-acp installed', 'success');
      renderAcpInstallStatus();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Install claude-code-acp';
      log.textContent += `\nFailed: ${err.toString()}`;
      toast(err.toString(), 'error');
    }
  });
}

