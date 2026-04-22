import { invoke, escapeHtml, toast, isClaudeAgent } from '../app.js';
import { openProfileChatAndSend } from './chat.js';

let searchResults = null;
let aiSearching = false;

// Structured job matches the agent has reported via the report_job_matches
// MCP tool. Module-scoped so renderSearch re-uses them after navigation,
// and the jobs:matched listener can update them mid-flight.
let aiMatches = [];
// Per-match state for the Set Up button (role creation + JD fetch +
// analysis). Keyed by URL since that's the unique identifier we have.
const settingUpByUrl = new Map(); // url -> 'setting-up' | 'done' | 'error'

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

  // Subscribe to the agent reporting new matches. Single listener; drop any
  // prior one so re-renders don't stack subscriptions.
  if (jobsMatchedUnlisten) { try { jobsMatchedUnlisten(); } catch {} }
  const { listen } = window.__TAURI__.event;
  jobsMatchedUnlisten = await listen('jobs:matched', (e) => {
    aiMatches = Array.isArray(e.payload) ? e.payload : [];
    renderAiResults(container);
    toast(`Found ${aiMatches.length} matches`, 'success');
  });

  container.innerHTML = `
    <h2>Job Search</h2>
    <p class="text-muted text-sm mb-16">Two ways to find roles: AI search is always free; JobBot is a paid backend you plug in.</p>

    <div class="search-tier-grid">
      <div class="card">
        <div class="card-header">
          <h3>AI Search <span class="badge badge-good">Free</span></h3>
        </div>
        <p class="text-muted text-sm mb-16">Claude reads your Search Criteria from Profile and scans the web for matching roles. Results land in the table below — click Set Up to add a role, auto-fetch the JD, and run analysis.</p>
        <div class="text-sm mb-16">
          <div class="text-muted">Uses:</div>
          <ul style="margin:4px 0 0 18px;padding:0">
            <li>Your <a href="#/profile" style="color:var(--accent)">search criteria</a> ${hasCriteria ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--yellow)">— not set yet</span>'}</li>
            <li>${escapeHtml(authLabel)} ${hasAuth ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--yellow)">— set an API key or install the Claude CLI</span>'}</li>
          </ul>
        </div>
        <button class="btn btn-primary" id="btn-ai-search" ${(!hasCriteria || !hasAuth) ? 'disabled' : ''}>
          ${aiSearching ? 'Searching…' : 'Start AI Search'}
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

  document.getElementById('btn-ai-search')?.addEventListener('click', async () => {
    aiSearching = true;
    const btn = document.getElementById('btn-ai-search');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    // Explicit tool usage + URL verification — without it, agents will
    // happily invent plausible-looking URLs that 404. The MCP tool call
    // at the end is what populates the Job Search table.
    const prompt = `Find real, currently-open job postings matching my search criteria (you already have it in context).

## Process (follow this — don't guess)
1. Use the WebSearch tool to find candidate postings. Query specific ATS domains that return real links, e.g.:
   - \`site:boards.greenhouse.io <role keywords> <company keyword or level>\`
   - \`site:jobs.lever.co <role keywords>\`
   - \`site:jobs.ashbyhq.com <role keywords>\`
   - Plus direct company career pages when a target company is in my criteria.
2. For EACH candidate URL, use the WebFetch tool to open the page and verify:
   - It loads (not 404, not a login wall, not a search page)
   - It IS a job posting (not a blog, not a generic careers page)
   - The role actually matches my criteria (don't stretch)
   - Extract title, company, location, remote status, salary if posted, posted date if visible
3. Only include verified postings. If you can only verify 3, return 3 — don't pad with unverified ones.

## Rules
- DO NOT invent URLs. Every URL you report must come from a real WebFetch that returned a valid job page.
- Skip LinkedIn (URLs return login walls), Indeed (requires auth), and anything more than 60 days old.
- If WebSearch is giving you weak results, try different queries before giving up.

## Output
Call the \`report_job_matches\` tool exactly once, with ALL verified matches in the single call. Fields: title, company, url, location, remote (bool), salary, posted_date (YYYY-MM-DD), reason (one sentence).

Then in chat, write a 1-2 sentence summary of what you found and any notable caveats (e.g. "only found 3 verifiable matches because queries returned mostly aggregator URLs"). Don't repeat the list — the table shows it.`;
    try {
      await openProfileChatAndSend(prompt, 'jobsearch');
    } catch (err) {
      toast(err.toString(), 'error');
    } finally {
      aiSearching = false;
    }
  });

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
  const buttonHtml = state === 'done'
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
