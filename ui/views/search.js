import { invoke, escapeHtml, toast } from '../app.js';
import { openProfileChatAndSend } from './chat.js';

let searchResults = null;
let aiSearching = false;

export async function renderSearch(container) {
  const settings = await invoke('get_settings');
  const hasCriteria = (settings.search_criteria || '').trim().length > 0;
  const hasApiKey = (settings.anthropic_api_key || '').trim().length > 0;
  const jobbotConfigured = settings.search_backend === 'jobbot'
    && (settings.jobbot_endpoint || '').trim().length > 0;

  container.innerHTML = `
    <h2>Job Search</h2>
    <p class="text-muted text-sm mb-16">Two ways to find roles: AI search is always free; JobBot is a paid backend you plug in.</p>

    <div class="search-tier-grid">
      <div class="card">
        <div class="card-header">
          <h3>AI Search <span class="badge badge-good">Free</span></h3>
        </div>
        <p class="text-muted text-sm mb-16">Claude reads your Search Criteria from Profile and scans the web for roles that match. Findings come back in chat — click a URL to open it, then Add Role + paste the URL to auto-fetch the JD and run analysis.</p>
        <div class="text-sm mb-16">
          <div class="text-muted">Uses:</div>
          <ul style="margin:4px 0 0 18px;padding:0">
            <li>Your <a href="#/profile" style="color:var(--accent)">search criteria</a> ${hasCriteria ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--yellow)">— not set yet</span>'}</li>
            <li>Anthropic API key ${hasApiKey ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--yellow)">— not set yet</span>'}</li>
          </ul>
        </div>
        <button class="btn btn-primary" id="btn-ai-search" ${(!hasCriteria || !hasApiKey) ? 'disabled' : ''}>
          ${aiSearching ? 'Searching…' : 'Start AI Search'}
        </button>
        ${(!hasCriteria || !hasApiKey) ? `
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

    <div id="search-results" class="mt-16">
      ${searchResults ? renderResults(searchResults) : ''}
    </div>
  `;

  document.getElementById('btn-ai-search')?.addEventListener('click', async () => {
    aiSearching = true;
    const btn = document.getElementById('btn-ai-search');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    const prompt = `Use my search criteria (you already have it in context) to find 5-10 open job postings on the public web. For each match, give me:

- Company and role title
- Direct URL to the posting (not a search results page)
- One-sentence reason it fits my criteria

Skip anything that's obviously stale, posted on LinkedIn (the URL won't work), or behind a login wall. Order by best-fit first.`;
    try {
      await openProfileChatAndSend(prompt, 'jobsearch');
    } catch (err) {
      toast(err.toString(), 'error');
    } finally {
      aiSearching = false;
      // Button state will be reset on next re-render; in the meantime it
      // stays disabled, which is correct while the chat runs.
    }
  });

  document.getElementById('btn-jobbot-search')?.addEventListener('click', async () => {
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = '<div class="loading"><div class="spinner"></div> Searching for jobs...</div>';
    try {
      searchResults = await invoke('run_job_search');
      resultsDiv.innerHTML = renderResults(searchResults);
      wireUpResults(container);
    } catch (err) {
      resultsDiv.innerHTML = `<div class="card"><p style="color:var(--red)">${escapeHtml(err.toString())}</p></div>`;
    }
  });

  if (searchResults) wireUpResults(container);
}

function renderResults(results) {
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

function wireUpResults(container) {
  if (!searchResults) return;
  container.querySelectorAll('.btn-setup').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
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
