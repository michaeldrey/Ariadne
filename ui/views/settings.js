import { invoke, escapeHtml, toast, invalidateAcpAgentCache } from '../app.js';

// Which section of the Settings page is active. Module-scoped so switching
// tabs re-renders without losing the active section on data refresh.
let activeSection = 'ai';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI & Backends' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'account', label: 'Account & Sync' },
];

export async function renderSettings(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading settings...</div>';
  const settings = await invoke('get_settings');

  container.innerHTML = `
    <h2>Settings</h2>
    <p class="text-muted text-sm mb-16">App configuration. Your personal content lives under <a href="#/profile" style="color:var(--accent)">Profile</a>.</p>

    <div class="settings-layout">
      <nav class="settings-nav">
        ${SECTIONS.map(s => `
          <button class="settings-nav-item ${s.id === activeSection ? 'active' : ''}" data-section="${s.id}">
            ${s.label}
          </button>
        `).join('')}
      </nav>
      <div class="settings-content" id="settings-content"></div>
    </div>
  `;

  container.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSection = btn.dataset.section;
      renderSettings(container);
    });
  });

  renderActiveSection(container, settings);
}

function renderActiveSection(container, settings) {
  const el = document.getElementById('settings-content');
  switch (activeSection) {
    case 'general':    return renderGeneral(el);
    case 'ai':         return renderAiBackends(el, settings, container);
    case 'integrations': return renderIntegrations(el, settings);
    case 'account':    return renderAccount(el);
  }
}

function renderGeneral(el) {
  el.innerHTML = `
    <div class="card mb-16">
      <h3>General</h3>
      <p class="text-muted text-sm mb-8">Ariadne is local-first. Your data lives on this machine — the SQLite database is at <code>~/Library/Application Support/com.ariadne.app/ariadne.db</code> on macOS.</p>
      <p class="text-muted text-sm">App-level preferences (theme, startup behavior, keyboard shortcuts) will live here when they exist.</p>
    </div>
  `;
}

function renderAiBackends(el, settings, container) {
  const hasKey = (settings.anthropic_api_key || '').trim().length > 0;
  const backend = settings.agent_backend || 'direct';

  el.innerHTML = `
    <div class="card mb-16">
      <h3>Authentication</h3>
      <p class="text-muted text-sm mb-16">Two ways to pay the LLM. You only need one.</p>

      <div id="auth-status" class="mb-16 text-sm">
        <div class="text-muted">Checking…</div>
      </div>

      <div class="auth-options">
        <div class="auth-option">
          <h4>Claude Pro/Max subscription</h4>
          <p class="text-muted text-sm mb-8">Flat monthly fee, no per-token billing. Requires the Claude Code CLI and a subscription. Only works with the ACP backend.</p>
          <ol class="text-sm text-muted" style="margin:0 0 12px 18px;padding:0">
            <li>Install the Claude Code CLI (<a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" style="color:var(--accent)">docs</a>).</li>
            <li>Run <code>claude /login</code> in a terminal.</li>
            <li>Leave the API Key below empty.</li>
          </ol>
        </div>
        <div class="auth-option">
          <h4>Anthropic API key</h4>
          <p class="text-muted text-sm mb-8">Pay-per-token. Works with both Direct and ACP backends. Get one at <code>console.anthropic.com</code>.</p>
          <div class="form-group">
            <div class="flex gap-8">
              <input type="password" id="anthropic-key" value="${escapeHtml(settings.anthropic_api_key) || ''}" placeholder="sk-ant-..." style="flex:1" />
              <button class="btn btn-sm" id="btn-save-anthropic">Save</button>
              ${hasKey ? '<button class="btn btn-sm btn-danger" id="btn-clear-anthropic">Clear</button>' : ''}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card mb-16">
      <h3>Agent Backend</h3>
      <p class="text-muted text-sm mb-8">Which engine runs chat + tool calls. ACP uses the Zed-maintained <code>claude-code-acp</code> adapter (multi-vendor pluggable, supports subscription auth). Direct hits the Anthropic API directly (API key only) and is scheduled for removal.</p>
      <div class="form-group">
        <label>Backend</label>
        <select id="agent-backend">
          <option value="direct" ${backend === 'direct' ? 'selected' : ''}>Direct (Anthropic Messages API)</option>
          <option value="acp" ${backend === 'acp' ? 'selected' : ''}>ACP (multi-vendor)</option>
        </select>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-backend">Save Backend</button>

      <div id="acp-install-status" class="text-sm mt-16 pt-8" style="border-top:1px solid var(--border)">
        <div class="text-muted">Checking <code>claude-code-acp</code> install…</div>
      </div>
    </div>

    <div class="card mb-16">
      <h3>ACP Agent</h3>
      <p class="text-muted text-sm mb-8">When ACP is selected above, which vendor's agent do we spawn? Only Claude unlocks the full Ariadne feature set — the others can chat but can't run one-shot analysis (Tailor Resume, Fetch JD, etc.), which are Claude-specific today.</p>
      <div class="form-group">
        <label>Agent</label>
        <select id="acp-agent">
          <option value="claude" ${(settings.acp_agent || 'claude') === 'claude' ? 'selected' : ''}>Claude (@zed-industries/claude-code-acp)</option>
          <option value="gemini" ${settings.acp_agent === 'gemini' ? 'selected' : ''}>Gemini (@google/gemini-cli --experimental-acp)</option>
          <option value="codex" ${settings.acp_agent === 'codex' ? 'selected' : ''}>Codex/GPT (@zed-industries/codex-acp)</option>
          <option value="custom" ${settings.acp_agent === 'custom' ? 'selected' : ''}>Custom command</option>
        </select>
      </div>
      <div class="form-group" id="acp-custom-row" style="${settings.acp_agent === 'custom' ? '' : 'display:none'}">
        <label>Custom Command</label>
        <input type="text" id="acp-custom-command" value="${escapeHtml(settings.acp_custom_command) || ''}" placeholder="e.g. npx -y some-other-acp-adapter@latest" style="font-family:var(--font-mono);font-size:12px" />
        <p class="text-muted text-sm mt-8">Any command that speaks ACP on stdio. Leading <code>NAME=value</code> args are parsed as env vars.</p>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-acp-agent">Save Agent</button>
    </div>
  `;

  document.getElementById('btn-save-anthropic').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { anthropic_api_key: document.getElementById('anthropic-key').value } });
      toast('Anthropic API key saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  document.getElementById('btn-clear-anthropic')?.addEventListener('click', async () => {
    try {
      await invoke('clear_api_key');
      toast('API key cleared', 'success');
      renderSettings(container);
    } catch (err) { toast(err.toString(), 'error'); }
  });

  document.getElementById('btn-save-backend').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { agent_backend: document.getElementById('agent-backend').value } });
      toast('Agent backend saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // ACP agent dropdown toggles the Custom Command row.
  document.getElementById('acp-agent').addEventListener('change', (e) => {
    document.getElementById('acp-custom-row').style.display = e.target.value === 'custom' ? '' : 'none';
  });
  document.getElementById('btn-save-acp-agent').addEventListener('click', async () => {
    try {
      await invoke('update_settings', {
        data: {
          acp_agent: document.getElementById('acp-agent').value,
          acp_custom_command: document.getElementById('acp-custom-command').value || null,
        }
      });
      invalidateAcpAgentCache();
      toast('ACP agent saved — restart the app for the change to take effect', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  renderAcpInstallStatus();
  renderAuthStatus(settings);
}

async function renderAuthStatus(settings) {
  const el = document.getElementById('auth-status');
  if (!el) return;
  const hasKey = (settings.anthropic_api_key || '').trim().length > 0;
  const backend = settings.agent_backend || 'direct';

  if (hasKey) {
    el.innerHTML = `<div style="color:var(--green)"><strong>✓ Using API key.</strong> Pay-per-token via Anthropic.</div>`;
    return;
  }

  // No API key — status depends on backend + Claude CLI presence.
  if (backend !== 'acp') {
    el.innerHTML = `<div style="color:var(--yellow)"><strong>No auth configured.</strong> Either set an API key below, or switch the backend to ACP and use Claude Pro/Max.</div>`;
    return;
  }

  let cli;
  try {
    cli = await invoke('detect_claude_cli');
  } catch {
    el.innerHTML = `<div style="color:var(--yellow)">Couldn't detect Claude CLI. Set an API key below or install the Claude Code CLI.</div>`;
    return;
  }
  if (!cli.installed) {
    el.innerHTML = `<div style="color:var(--yellow)"><strong>Claude Code CLI not installed.</strong> Install it (<a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" style="color:var(--accent)">docs</a>) to use Pro/Max auth, or set an API key below.</div>`;
    return;
  }
  const version = cli.version ? ` (v${escapeHtml(cli.version)})` : '';
  el.innerHTML = `
    <div style="color:var(--green)"><strong>✓ Claude CLI detected${version}.</strong> If you've run <code>claude /login</code>, chat will use your Pro/Max subscription. No API key needed.</div>
    <div class="text-muted text-xs mt-8">If you get an auth error when chatting, run <code>claude /login</code> in a terminal to refresh credentials.</div>
  `;
}

function renderIntegrations(el, settings) {
  el.innerHTML = `
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
        <input type="url" id="jobbot-endpoint" value="${escapeHtml(settings.jobbot_endpoint) || ''}" placeholder="https://..." />
      </div>
      <div class="form-group">
        <label>JobBot API Key</label>
        <input type="password" id="jobbot-key" value="${escapeHtml(settings.jobbot_api_key) || ''}" placeholder="API key" />
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-search">Save Search Config</button>
    </div>

    <div class="card mb-16">
      <h3>Gmail</h3>
      <p class="text-muted text-sm">Planned: one-click inbox scan for job status updates (rejections, interview invites, recruiter outreach). Auto-updates role stages where the match is unambiguous.</p>
      <button class="btn btn-sm" disabled title="Not yet available">Connect Gmail</button>
    </div>
  `;

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

function renderAccount(el) {
  el.innerHTML = `
    <div class="card mb-16">
      <h3>Account & Sync</h3>
      <p class="text-muted text-sm mb-8">Ariadne is local-first — your data lives on this machine. Cloud sync across devices is planned but not yet available.</p>
      <button class="btn btn-sm" disabled title="Not yet available">Sign in</button>
    </div>
  `;
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
