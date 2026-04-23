import { invoke, escapeHtml, toast, isClaudeAgent } from '../app.js';

let searchResults = null;

// AI Search target — how many verified matches to aim for per run, and the
// cap on how many rounds we'll re-prompt to reach it. Will be user-tunable
// in Settings later (tracked in backlog).
const AI_SEARCH_TARGET = 10;
const AI_SEARCH_MAX_ROUNDS = 3;

// AI Search runtime state — module-scoped so the search keeps running if the
// user navigates away, and so re-renders re-hydrate the banner/button.
let aiSearchState = 'idle'; // 'idle' | 'searching' | 'done'
let aiSearchRound = 0;
let aiSearchRoundMessage = '';
let jobSearchConversationId = null;

// Structured job matches the agent has reported via commit_job_matches.
// Accumulated across rounds within a single run (deduped by URL).
let aiMatches = [];
// Per-match state for the Set Up button (role creation + JD fetch +
// analysis). Keyed by URL.
const settingUpByUrl = new Map();
const createdRoleIdByUrl = new Map();

let jobsMatchedUnlisten = null;

export async function renderSearch(container) {
  const settings = await invoke('get_settings');
  const hasCriteria = (settings.search_criteria || '').trim().length > 0;
  const hasApiKey = (settings.anthropic_api_key || '').trim().length > 0;

  // If no API key, check for Claude CLI — Pro/Max subscription auth also
  // counts as a valid auth path for the ACP backend.
  let claudeCliDetected = false;
  let claudeCliVersion = null;
  if (!hasApiKey) {
    try {
      const cli = await invoke('detect_claude_cli');
      claudeCliDetected = !!cli.installed;
      claudeCliVersion = cli.version || null;
    } catch { /* treat as not detected */ }
  }
  const hasAuth = hasApiKey || claudeCliDetected;
  const authLabel = hasApiKey
    ? 'Anthropic API key set'
    : claudeCliDetected
      ? `Claude Code CLI${claudeCliVersion ? ` v${claudeCliVersion}` : ''} — using Pro/Max subscription`
      : 'No auth configured';

  const jobbotConfigured = settings.search_backend === 'jobbot'
    && (settings.jobbot_endpoint || '').trim().length > 0;

  // Subscribe to the agent reporting new matches. Merge into the running
  // accumulator (dedup by URL) so multi-round runs grow the table instead
  // of replacing it. Single listener; drop any prior one so re-renders
  // don't stack subscriptions.
  if (jobsMatchedUnlisten) { try { jobsMatchedUnlisten(); } catch {} }
  const { listen } = window.__TAURI__.event;
  jobsMatchedUnlisten = await listen('jobs:matched', (e) => {
    const incoming = Array.isArray(e.payload) ? e.payload : [];
    const existing = new Set(aiMatches.map(m => m.url));
    const novel = incoming.filter(m => m && m.url && !existing.has(m.url));
    aiMatches = [...aiMatches, ...novel];
    renderAiResults(container);
  });

  const running = aiSearchState === 'searching';
  container.innerHTML = `
    <h2>Job Search</h2>
    <p class="text-muted text-sm mb-16">Two ways to find roles: AI search is always free; JobBot is a paid backend you plug in.</p>

    <div class="search-tier-grid">
      <div class="card">
        <div class="card-header">
          <h3>AI Search <span class="badge badge-good">Free</span></h3>
        </div>
        <p class="text-muted text-sm mb-8">Claude scans ATS-powered job boards (Greenhouse, Lever, Ashby) and direct company career pages for openings matching your <a href="#/profile" style="color:var(--accent)">search criteria</a>. Each URL is triple-verified — server liveness check, content-looks-like-a-job-posting check, and the agent re-opens the page to confirm the title + company match — to keep hallucinated listings out of the table.</p>
        <p class="text-muted text-sm mb-16"><strong>Expect 1–5 minutes per run.</strong> Aims for up to ${AI_SEARCH_TARGET} verified matches across up to ${AI_SEARCH_MAX_ROUNDS} passes. Returns fewer if that's all the agent can verify — quality over quantity. Runs in the background; feel free to keep using the app.</p>
        <div class="text-sm mb-16">
          <div class="text-muted">Prereqs:</div>
          <ul style="margin:4px 0 0 18px;padding:0">
            <li>Your <a href="#/profile" style="color:var(--accent)">search criteria</a> ${hasCriteria ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--yellow)">— not set yet</span>'}</li>
            <li>${escapeHtml(authLabel)} ${hasAuth ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--yellow)">— set an API key or install the Claude CLI</span>'}</li>
          </ul>
        </div>
        <button class="btn btn-primary" id="btn-ai-search" ${(!hasCriteria || !hasAuth) || running ? 'disabled' : ''}>
          ${running ? escapeHtml(aiSearchRoundMessage || 'Running…') : 'Start AI Search'}
        </button>
        ${(!hasCriteria || !hasAuth) ? `
          <p class="text-muted text-sm mt-8">Fill in missing pieces above to enable.</p>
        ` : ''}
      </div>

      <div class="card">
        <div class="card-header">
          <h3>JobBot <span class="badge badge-strong">Premium</span></h3>
        </div>
        <p class="text-muted text-sm mb-16">Curated feed from a paid search API. Configure your endpoint + API key in <a href="#/settings" style="color:var(--accent)">Settings → Integrations</a>, then run below.</p>
        ${jobbotConfigured ? `
          <button class="btn btn-primary" id="btn-jobbot-search">Run JobBot Search</button>
        ` : `
          <p class="text-muted text-sm mb-16">Status: not configured. Configure an endpoint + key in Settings, or skip — AI Search covers the free case.</p>
          <a href="#/settings" class="btn btn-sm">Configure JobBot</a>
        `}
      </div>
    </div>

    <div id="ai-results" class="mt-16"></div>
    <div id="search-results" class="mt-16">
      ${searchResults ? renderJobBotResults(searchResults) : ''}
    </div>
  `;

  renderAiResults(container);

  document.getElementById('btn-ai-search')?.addEventListener('click', () => runAiSearch(container));

  document.getElementById('btn-jobbot-search')?.addEventListener('click', async () => {
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = '<div class="loading"><div class="spinner"></div> Searching for jobs...</div>';
    try {
      searchResults = await invoke('run_job_search');
      resultsDiv.innerHTML = renderJobBotResults(searchResults);
      wireJobBotResults(container);
    } catch (err) {
      resultsDiv.innerHTML = `<div class="card"><p style="color:var(--red)">${escapeHtml(err.toString())}</p></div>`;
    }
  });

  if (searchResults) wireJobBotResults(container);
}

// ── AI Search background runner ──

// Runs the search in the background (no chat drawer). Multi-round: if the
// first pass returns fewer than AI_SEARCH_TARGET verified matches, we loop
// up to AI_SEARCH_MAX_ROUNDS asking the agent for different postings than
// it already found. The button itself reflects the current stage/round.
async function runAiSearch(container) {
  if (aiSearchState === 'searching') return;
  aiSearchState = 'searching';
  aiMatches = [];           // fresh run — reset accumulator
  aiSearchRound = 0;
  aiSearchRoundMessage = 'Starting…';
  settingUpByUrl.clear();
  createdRoleIdByUrl.clear();
  renderAiResults(container);
  updateAiSearchButton(container);

  try {
    const convId = await ensureJobSearchConversation();
    for (let round = 1; round <= AI_SEARCH_MAX_ROUNDS; round++) {
      if (aiMatches.length >= AI_SEARCH_TARGET) break;

      aiSearchRound = round;
      const need = Math.max(1, AI_SEARCH_TARGET - aiMatches.length);
      aiSearchRoundMessage = `Round ${round}/${AI_SEARCH_MAX_ROUNDS} — searching for ${need} more…`;
      updateAiSearchButton(container);

      const prompt = buildAiSearchPrompt(need, aiMatches);
      try {
        await invoke('send_to_conversation_acp', {
          conversationId: convId,
          userText: prompt,
        });
      } catch (err) {
        toast(`AI Search round ${round} failed: ${err}`, 'error');
        break;
      }
    }

    aiSearchState = 'done';
    aiSearchRoundMessage = '';
    updateAiSearchButton(container);
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = window.__TAURI__.notification;
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (granted) {
        sendNotification({
          title: 'Ariadne: AI Search done',
          body: `${aiMatches.length} verified match${aiMatches.length === 1 ? '' : 'es'} ready to review.`,
        });
      }
    } catch { /* notifications optional */ }
    toast(`AI Search done — ${aiMatches.length} verified match${aiMatches.length === 1 ? '' : 'es'}`,
      aiMatches.length > 0 ? 'success' : 'info');
  } catch (err) {
    aiSearchState = 'done';
    aiSearchRoundMessage = '';
    updateAiSearchButton(container);
    toast(err.toString(), 'error');
  }
}

function updateAiSearchButton(container) {
  const btn = document.getElementById('btn-ai-search');
  if (!btn) return;
  if (aiSearchState === 'searching') {
    btn.disabled = true;
    btn.textContent = aiSearchRoundMessage || 'Running…';
  } else {
    btn.disabled = false;
    btn.textContent = 'Start AI Search';
  }
}

async function ensureJobSearchConversation() {
  if (jobSearchConversationId) return jobSearchConversationId;
  const conv = await invoke('create_conversation', {
    scopeType: 'profile',
    roleId: null,
    title: 'Job Search',
  });
  jobSearchConversationId = conv.id;
  return conv.id;
}

function buildAiSearchPrompt(need, already) {
  const existingList = already.length > 0
    ? `\n\n## URLs you've already verified this run (do NOT return these again, find DIFFERENT ones):\n${already.map(m => `- ${m.url}  (${m.company} — ${m.title})`).join('\n')}`
    : '';
  return `Find up to ${need} real, currently-open job postings matching my search criteria (you already have it in context). Use the two-stage verification flow — don't skip either stage.

## Process

### Stage 0: Discovery
Use WebSearch with ATS-domain queries:
- \`site:boards.greenhouse.io <role keywords>\`
- \`site:jobs.lever.co <role keywords>\`
- \`site:jobs.ashbyhq.com <role keywords>\`
- Direct company career pages for target companies in my criteria.
Skip LinkedIn (login walls), Indeed (auth), anything >60 days old.

### Stage 1: Stage for server verification
Call \`report_job_matches\` with your candidate list. The server checks liveness + content. The tool result lists which URLs passed.

### Stage 2: Verify content matches (CRITICAL)
For each URL that passed stage 1, WebFetch the page and confirm:
- The on-page role title matches what you claimed
- The on-page company matches what you claimed
- The role actually fits my criteria

### Stage 3: Commit
Call \`commit_job_matches\` with ONLY the fully-verified subset. Empty list is acceptable — never pad with unverified guesses.

## Rules
- Accuracy over quantity. ${need === 0 ? '' : `Up to ${need} verified matches this round.`}
- NEVER invent URLs.
- After commit, one-sentence summary in chat.${existingList}`;
}

// ── AI Search results table ──

function renderAiResults(container) {
  const el = document.getElementById('ai-results');
  if (!el) return;
  if (aiMatches.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>AI Search Results (${aiMatches.length})</h3>
      </div>
      <p class="text-muted text-sm mb-8" style="padding:0 16px">
        ⚠ LLM-generated list. Each URL is server-verified to load and look like a job posting, but verify the role still matches the description before applying.
      </p>
      <div class="table-container">
        <table class="ai-search-table">
          <colgroup>
            <col class="col-company" />
            <col />
            <col class="col-location" />
            <col class="col-remote" />
            <col class="col-salary" />
            <col class="col-posted" />
            <col class="col-match" />
            <col class="col-action" />
          </colgroup>
          <thead>
            <tr>
              <th>Company</th>
              <th>Role</th>
              <th>Location</th>
              <th>Remote</th>
              <th>Salary</th>
              <th>Posted</th>
              <th>Match</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${aiMatches.map((m, i) => renderAiRow(m, i)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  wireAiResults(container);
}

function renderAiRow(m, i) {
  const state = settingUpByUrl.get(m.url);
  const roleId = createdRoleIdByUrl.get(m.url);
  const buttonHtml = state === 'done' && roleId
    ? `<a class="btn btn-sm btn-primary" href="#/roles/${roleId}">View →</a>`
    : state === 'done'
      ? `<span class="text-sm" style="color:var(--green)">✓ Added</span>`
      : state === 'setting-up'
        ? `<button class="btn btn-sm" disabled>Setting up…</button>`
        : `<button class="btn btn-sm btn-primary btn-ai-setup" data-index="${i}">Set Up</button>`;

  const remoteBadge = m.remote === true
    ? '<span class="badge badge-good">Remote</span>'
    : m.remote === false
      ? '<span class="text-muted text-sm">On-site</span>'
      : '<span class="text-muted">—</span>';

  return `
    <tr>
      <td><strong>${escapeHtml(m.company || '—')}</strong></td>
      <td>
        ${escapeHtml(m.title || '—')}
        ${m.url ? `<br><a href="${escapeHtml(m.url)}" target="_blank" class="text-muted text-sm" style="color:var(--accent)">View posting &nearr;</a>` : ''}
      </td>
      <td class="text-sm">${escapeHtml(m.location || '—')}</td>
      <td class="text-sm">${remoteBadge}</td>
      <td class="text-sm">${escapeHtml(m.salary || '—')}</td>
      <td class="text-sm text-muted">${escapeHtml(m.posted_date || '—')}</td>
      <td class="text-sm text-muted">
        <div class="ai-match-cell" title="${escapeHtml(m.reason || '')}">${escapeHtml(m.reason || '')}</div>
      </td>
      <td>${buttonHtml}</td>
    </tr>
  `;
}

function wireAiResults(container) {
  container.querySelectorAll('.btn-ai-setup').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const match = aiMatches[idx];
      if (!match || !match.url) return;
      await setupFromAiMatch(match, container);
    });
  });
}

// Full pipeline: create role → fetch JD → run analysis. Re-renders the row
// after each step so the user sees progress.
async function setupFromAiMatch(match, container) {
  settingUpByUrl.set(match.url, 'setting-up');
  renderAiResults(container);
  const claudeOnly = await isClaudeAgent();
  try {
    const role = await invoke('create_role', {
      data: {
        company: match.company,
        title: match.title,
        url: match.url,
      },
    });
    createdRoleIdByUrl.set(match.url, role.id);
    // Claude-only: fetch_jd_from_url + tailor_resume use Anthropic/CLI.
    // On other agents we just create the role; user can paste the JD and
    // ask the agent to analyze it via chat.
    if (!claudeOnly) {
      settingUpByUrl.set(match.url, 'done');
      renderAiResults(container);
      toast(`Added ${match.company} — ${match.title}. Open the role to paste a JD.`, 'success');
      return;
    }
    let jd = null;
    try {
      jd = await invoke('fetch_jd_from_url', { url: match.url });
      await invoke('update_role', { id: role.id, data: { jd_content: jd } });
    } catch (err) {
      toast(`JD fetch failed for ${match.company}: ${err}. Role added; fetch manually.`, 'error');
      settingUpByUrl.set(match.url, 'done');
      renderAiResults(container);
      return;
    }
    try {
      await invoke('tailor_resume', { roleId: role.id });
    } catch (err) {
      toast(`Analysis for ${match.company} failed: ${err}`, 'error');
    }
    settingUpByUrl.set(match.url, 'done');
    renderAiResults(container);
    toast(`Added ${match.company} — ${match.title}`, 'success');
  } catch (err) {
    settingUpByUrl.set(match.url, 'error');
    renderAiResults(container);
    toast(err.toString(), 'error');
  }
}

// ── JobBot results (existing) ──

function renderJobBotResults(results) {
  const { jobs, meta } = results;
  return `
    <div class="card mb-16">
      <p class="text-sm">
        Searched: <strong>${meta.companies_searched.length}</strong> companies
        ${meta.companies_not_supported.length > 0 ? ` | Not supported: ${meta.companies_not_supported.join(', ')}` : ''}
        | Found: <strong>${jobs.length}</strong> jobs
        (${meta.total_collected} collected, ${meta.after_exclusion} after filtering)
      </p>
    </div>

    ${jobs.length > 0 ? `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Company</th>
              <th>Role</th>
              <th>Location</th>
              <th>Posted</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.map((job, i) => `
              <tr>
                <td class="mono text-muted">${i + 1}</td>
                <td><strong>${escapeHtml(job.company)}</strong></td>
                <td>${escapeHtml(job.title)}</td>
                <td class="text-sm">${escapeHtml(job.location)}</td>
                <td class="text-sm text-muted">${job.posted_date || '—'}</td>
                <td>
                  <div class="btn-group">
                    <button class="btn btn-sm btn-primary btn-setup" data-index="${i}">Setup</button>
                    ${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" class="btn btn-sm">View &nearr;</a>` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<div class="empty-state"><p>No new jobs found</p></div>'}
  `;
}

function wireJobBotResults(container) {
  if (!searchResults) return;
  container.querySelectorAll('.btn-setup').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const job = searchResults.jobs[idx];
      try {
        const role = await invoke('quick_add_from_search', { job });
        toast(`Added: ${role.company} — ${role.title}`, 'success');
        btn.textContent = 'Added';
        btn.disabled = true;
        btn.classList.remove('btn-primary');
      } catch (err) {
        toast(err.toString(), 'error');
      }
    });
  });
}
