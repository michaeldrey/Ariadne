import { invoke, escapeHtml, toast } from '../app.js';

let searchResults = null;

export async function renderSearch(container) {
  container.innerHTML = `
    <div class="flex-between mb-16">
      <h2>Job Search</h2>
      <button class="btn btn-primary" id="btn-run-search">Run Search</button>
    </div>

    <div id="search-results">
      ${searchResults ? renderResults(searchResults) : `
        <div class="empty-state">
          <div class="icon">&#8981;</div>
          <p>Click "Run Search" to find new roles via JobBot API</p>
          <p class="text-sm text-muted">Configure your JobBot credentials in Settings first</p>
        </div>
      `}
    </div>
  `;

  document.getElementById('btn-run-search').addEventListener('click', async () => {
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
