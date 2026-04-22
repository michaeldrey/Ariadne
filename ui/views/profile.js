import { invoke, escapeHtml, toast, renderMarkdown } from '../app.js';
import { openProfileChat, openProfileChatAndSend } from './chat.js';

// Parse markdown work stories. Supports two formats:
//   (a) `## Title` + `**Situation:** / **Task:** / **Action:** / **Result:**` inline labels
//   (b) `## Title` + `### Situation / ### Action / ### Result / ### Context / ...` h3 sections
//       plus optional `**Company:** / **Timeframe:** / **Role:** / **Themes:**` metadata
// Returns: [{title, meta: {company, timeframe, role, themes}, sections: [{label, content}]}]
//
// Skips obvious template/index blocks (Template, Example Story, Index, Your Stories, etc.)
function parseStories(md) {
  if (!md) return [];
  const SKIP_TITLES = /^(story\s+template|example\s+story|your\s+stories|index|template|common\s+interview\s+patterns)\b/i;

  const stories = [];
  const blocks = md.split(/^##\s+/m).slice(1);

  for (const block of blocks) {
    const firstNL = block.indexOf('\n');
    const title = (firstNL === -1 ? block : block.slice(0, firstNL)).trim();
    if (SKIP_TITLES.test(title)) continue;

    const body = firstNL === -1 ? '' : block.slice(firstNL + 1);

    // Metadata (leading **Key:** value lines before any ### or blank content).
    const meta = {};
    const metaRe = /\*\*(Company|Timeframe|Role|Themes)\*\*:?\s*([^\n]+)/gi;
    let mm;
    while ((mm = metaRe.exec(body)) !== null) {
      meta[mm[1].toLowerCase()] = mm[2].trim();
    }

    // Try format (b): ### Headers
    const h3Sections = [];
    const h3Re = /^###\s+(.+?)$/gm;
    const h3Matches = [...body.matchAll(h3Re)];
    if (h3Matches.length > 0) {
      for (let i = 0; i < h3Matches.length; i++) {
        const label = h3Matches[i][1].trim();
        const startAfterHeader = h3Matches[i].index + h3Matches[i][0].length;
        const endAtNext = i + 1 < h3Matches.length ? h3Matches[i + 1].index : body.length;
        const content = body.slice(startAfterHeader, endAtNext).trim();
        if (content) h3Sections.push({ label, content });
      }
    }

    // Try format (a): **Label:** inline sections.
    const inlineSections = [];
    if (h3Sections.length === 0) {
      const labels = ['Situation', 'Task', 'Action', 'Result'];
      for (const label of labels) {
        const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*\\w+:\\*\\*|$)`, 'i');
        const m = body.match(re);
        if (m && m[1].trim()) inlineSections.push({ label, content: m[1].trim() });
      }
    }

    const sections = h3Sections.length > 0 ? h3Sections : inlineSections;

    // Skip empty shells — no sections AND no meta AND no title content beyond the header.
    if (sections.length === 0 && Object.keys(meta).length === 0) continue;

    stories.push({ title, meta, sections });
  }
  return stories;
}

let editingStories = false;

export async function renderProfile(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading profile...</div>';

  const settings = await invoke('get_settings');

  const hasResume = (settings.resume_content || '').trim().length > 0;
  const hasApiKey = (settings.anthropic_api_key || '').trim().length > 0;
  const canChat = hasApiKey;

  const chatDisabledReason = !hasApiKey
    ? 'Add your Anthropic API key in Settings first'
    : '';

  container.innerHTML = `
    <div class="flex-between mb-16">
      <div>
        <h2 style="margin-bottom:4px">Profile</h2>
        <p class="text-muted text-sm">Your information. Claude reads this when helping with tailoring, research, and outreach.</p>
      </div>
      <button class="btn btn-primary" id="btn-open-profile-chat" ${canChat ? '' : `disabled title="${escapeHtml(chatDisabledReason)}"`}>Chat with Coach</button>
    </div>

    <div class="card mb-16">
      <h3>Identity</h3>
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="profile-name" value="${escapeHtml(settings.profile_name) || ''}" placeholder="Your name" />
      </div>
      <div class="form-group">
        <label>Resume PDF Filename</label>
        <input type="text" id="resume-filename" value="${escapeHtml(settings.resume_filename) || 'Resume.pdf'}" placeholder="Resume.pdf" />
      </div>
      <div class="form-group">
        <label>About (markdown)</label>
        <textarea id="profile-md" placeholder="Background, target roles, compensation goals…" style="min-height:140px">${escapeHtml(settings.profile_json) || ''}</textarea>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-save-profile">Save</button>
    </div>

    <div class="card mb-16">
      <h3>Master Resume</h3>
      <p class="text-muted text-sm mb-8">In markdown. Used as the source for tailored resumes and STAR story generation.</p>
      <textarea id="resume-content" style="min-height:220px">${escapeHtml(settings.resume_content) || ''}</textarea>
      <button class="btn btn-sm btn-primary mt-16" id="btn-save-resume">Save</button>
    </div>

    <div class="card mb-16">
      <div class="card-header">
        <h3>Work Stories (STAR)</h3>
        <div class="btn-group">
          <button class="btn btn-sm" id="btn-build-stories-chat" ${canChat ? '' : `disabled title="${escapeHtml(chatDisabledReason)}"`}>Build with Coach</button>
          <button class="btn btn-sm ${editingStories ? 'btn-primary' : ''}" id="btn-toggle-stories-edit">${editingStories ? 'Save & View' : 'Edit Markdown'}</button>
        </div>
      </div>
      <p class="text-muted text-sm mb-16">
        Interview stories in STAR format. Claude uses these when tailoring resumes and prepping for behavioral rounds.
        Use the Coach to interview yourself — it asks one question at a time and saves stories via a tool call.
      </p>
      <div id="stories-body"></div>
    </div>

    <div class="card mb-16">
      <h3>Search Criteria</h3>
      <p class="text-muted text-sm mb-8">Target companies, excluded companies, must-haves, dealbreakers. Claude references this when evaluating new roles.</p>
      <textarea id="search-criteria" placeholder="Target: Series B+ infra companies hiring Staff SEs. Excluded: …" style="min-height:160px">${escapeHtml(settings.search_criteria) || ''}</textarea>
      <button class="btn btn-sm btn-primary mt-16" id="btn-save-search-criteria">Save</button>
    </div>
  `;

  // Save identity
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

  // Save resume
  document.getElementById('btn-save-resume').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { resume_content: document.getElementById('resume-content').value } });
      toast('Resume saved', 'success');
      renderProfile(container); // re-render so the Generate button enables
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Save search criteria
  document.getElementById('btn-save-search-criteria').addEventListener('click', async () => {
    try {
      await invoke('update_settings', { data: { search_criteria: document.getElementById('search-criteria').value || null } });
      toast('Search criteria saved', 'success');
    } catch (err) { toast(err.toString(), 'error'); }
  });

  // Stories view/edit toggle
  renderStoriesBody(settings.work_stories || '');
  document.getElementById('btn-toggle-stories-edit').addEventListener('click', async () => {
    if (editingStories) {
      const value = document.getElementById('work-stories').value;
      try {
        await invoke('update_settings', { data: { work_stories: value } });
        toast('Work stories saved', 'success');
        editingStories = false;
        renderProfile(container);
      } catch (err) { toast(err.toString(), 'error'); }
    } else {
      editingStories = true;
      renderProfile(container);
    }
  });

  // Top-right: open profile chat (blank slate).
  document.getElementById('btn-open-profile-chat').addEventListener('click', () => {
    if (!canChat) return;
    openProfileChat();
  });

  // Work Stories card: seed the chat with a "let's build stories" prompt.
  document.getElementById('btn-build-stories-chat').addEventListener('click', () => {
    if (!canChat) return;
    const hasStories = (settings.work_stories || '').trim().length > 0;
    const seed = hasStories
      ? 'Review my existing work stories with me. Identify weak/empty sections, ask one focused question per turn, and when I approve, update them via save_work_stories (preserve the ones I like).'
      : 'Interview me to build STAR stories from my resume. Ask one focused question per turn. When you have enough, draft stories and confirm with me before saving via save_work_stories.';
    openProfileChatAndSend(seed);
  });
}

function renderStoriesBody(md) {
  const el = document.getElementById('stories-body');
  if (!el) return;

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
    el.innerHTML = `<div class="empty-state"><p>No stories yet. Click "Generate from Resume" or "Edit Markdown" to add some.</p></div>`;
    return;
  }

  el.innerHTML = stories.map((s, i) => {
    // Preview: prefer Result, then Action, then Situation, then first section.
    const pick = (label) => s.sections.find(x => x.label.toLowerCase() === label.toLowerCase())?.content;
    const previewSrc = pick('Result') || pick('Action') || pick('Situation') || s.sections[0]?.content || '';
    const preview = previewSrc.replace(/[\s*_`#>-]+/g, ' ').trim().slice(0, 150);

    const metaBits = [];
    if (s.meta.company) metaBits.push(escapeHtml(s.meta.company));
    if (s.meta.role) metaBits.push(escapeHtml(s.meta.role));
    if (s.meta.timeframe) metaBits.push(escapeHtml(s.meta.timeframe));
    const metaLine = metaBits.length > 0
      ? `<div class="story-meta">${metaBits.join(' · ')}</div>`
      : '';

    return `
      <div class="story-card" data-story-idx="${i}">
        <div class="story-header">
          <div style="flex:1;min-width:0">
            <div class="story-title">${escapeHtml(s.title)}</div>
            ${metaLine}
            <div class="story-preview">${escapeHtml(preview)}${preview.length >= 150 ? '…' : ''}</div>
          </div>
          <button class="btn btn-sm" data-toggle-story="${i}">Expand</button>
        </div>
        <div class="story-body hidden" data-story-body="${i}">
          ${s.sections.map(section => `
            <div class="story-section">
              <div class="story-label">${escapeHtml(section.label)}</div>
              <div class="markdown-content">${renderMarkdown(section.content)}</div>
            </div>
          `).join('')}
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
