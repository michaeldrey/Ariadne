import { invoke, escapeHtml, formatDate, stageBadgeClass, fitScoreClass, toast, navigate } from '../app.js';
import { openInterviewChat } from './chat.js';

const MODES = [
  { id: 'behavioral', label: 'Behavioral', icon: '💬', description: 'STAR-format questions about leadership, conflict, teamwork, failure, and impact.' },
  { id: 'technical', label: 'Technical', icon: '⚙', description: 'Role-specific technical deep dives based on the JD and your background.' },
  { id: 'system_design', label: 'System Design', icon: '🏗', description: 'Architecture questions scoped to the company\'s domain and scale.' },
  { id: 'mixed', label: 'Full Loop', icon: '🔄', description: 'Simulates a realistic interview loop — mix of behavioral, technical, and design.' },
];

let selectedRoleId = null;

/// Pre-select a role before navigating to the Interview Prep view. Used by
/// the 'Practice Interview' button on the role detail page so clicking it
/// drops the user on this page with their role already highlighted.
export function preselectRole(roleId) {
  selectedRoleId = roleId;
}

export async function renderInterview(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';

  const allRoles = await invoke('list_roles', { status: 'active' });
  const interviewReady = allRoles.filter(r =>
    ['Applied', 'Recruiter Screen', 'HM Interview', 'Onsite', 'Offer', 'Negotiating'].includes(r.stage)
  );
  const sourced = allRoles.filter(r => r.stage === 'Sourced');

  container.innerHTML = `
    <h2>Interview Prep</h2>
    <p class="text-muted text-sm mb-16">Practice with an AI interviewer that knows the role, company, and your background. Use your mic for a realistic conversation flow.</p>

    <div class="card mb-16">
      <h3>Select a Role</h3>
      ${interviewReady.length === 0 && sourced.length === 0
        ? '<div class="empty-state"><p>No active roles. <a href="#/roles" style="color:var(--accent)">Add a role</a> to start practicing.</p></div>'
        : `
          <div class="interview-role-grid">
            ${interviewReady.map(r => renderRoleCard(r, true)).join('')}
            ${sourced.length > 0 ? `
              <details class="mt-16" style="grid-column:1/-1">
                <summary class="text-muted text-sm" style="cursor:pointer">Sourced roles (${sourced.length}) — less context available</summary>
                <div class="interview-role-grid mt-8">
                  ${sourced.map(r => renderRoleCard(r, false)).join('')}
                </div>
              </details>
            ` : ''}
          </div>
        `
      }
    </div>

    <div id="interview-mode-section" class="${selectedRoleId ? '' : 'hidden'}">
      <div class="card mb-16">
        <h3>Choose Interview Mode</h3>
        <div class="interview-mode-grid">
          ${MODES.map(m => `
            <button class="interview-mode-card" data-mode="${m.id}">
              <div class="interview-mode-icon">${m.icon}</div>
              <div class="interview-mode-label">${m.label}</div>
              <div class="interview-mode-desc">${m.description}</div>
            </button>
          `).join('')}
        </div>
      </div>

      <div class="card mb-16">
        <h3>Tips</h3>
        <ul class="text-sm" style="padding-left:18px;color:var(--text-secondary)">
          <li>Click the <strong>mic button</strong> in chat to answer with your voice — great for practicing verbal fluency</li>
          <li>The interviewer has access to the JD, your resume, work stories, and research packet</li>
          <li>Ask for feedback after each answer — "How was that?" or "Score my answer"</li>
          <li>Sessions are saved as conversations — review them later from the role's chat</li>
        </ul>
      </div>
    </div>
  `;

  // Wire role selection
  container.querySelectorAll('.interview-role-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedRoleId = card.dataset.roleId;
      container.querySelectorAll('.interview-role-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('interview-mode-section')?.classList.remove('hidden');
    });
    // Pre-select if we had one from before
    if (card.dataset.roleId === selectedRoleId) {
      card.classList.add('selected');
    }
  });

  // Show mode section if role was already selected
  if (selectedRoleId && allRoles.find(r => r.id === selectedRoleId)) {
    document.getElementById('interview-mode-section')?.classList.remove('hidden');
  }

  // Wire mode selection
  container.querySelectorAll('.interview-mode-card').forEach(card => {
    card.addEventListener('click', async () => {
      if (!selectedRoleId) { toast('Select a role first', 'error'); return; }
      const mode = card.dataset.mode;
      const role = allRoles.find(r => r.id === selectedRoleId);
      if (!role) { toast('Role not found', 'error'); return; }
      await startInterviewSession(role, mode);
    });
  });
}

function renderRoleCard(role, ready) {
  return `
    <button class="interview-role-card ${selectedRoleId === role.id ? 'selected' : ''}" data-role-id="${role.id}">
      <div class="interview-role-company">${escapeHtml(role.company)}</div>
      <div class="interview-role-title">${escapeHtml(role.title)}</div>
      <div class="interview-role-meta">
        <span class="badge ${stageBadgeClass(role.stage)}">${escapeHtml(role.stage)}</span>
        ${role.fit_score ? `<span class="fit-score ${fitScoreClass(role.fit_score)}" style="width:28px;height:28px;font-size:11px">${role.fit_score}</span>` : ''}
        ${!role.jd_content ? '<span class="text-muted text-sm">No JD</span>' : ''}
      </div>
    </button>
  `;
}

async function startInterviewSession(role, mode) {
  const modeLabel = MODES.find(m => m.id === mode)?.label || mode;
  const prompt = buildInterviewPrompt(role, mode, modeLabel);
  await openInterviewChat(role, mode, prompt);
}

function buildInterviewPrompt(role, mode, modeLabel) {
  switch (mode) {
    case 'behavioral':
      return `Start a behavioral interview for the ${escapeHtml(role.title)} role at ${escapeHtml(role.company)}. Ask me one STAR-format question at a time. After I answer, give brief feedback and move to the next question. Focus on leadership, conflict resolution, ambiguity, and impact. Go.`;
    case 'technical':
      return `Start a technical interview for the ${escapeHtml(role.title)} role at ${escapeHtml(role.company)}. Ask me one technical question at a time based on the JD requirements. After I answer, evaluate my response and follow up or move on. Go.`;
    case 'system_design':
      return `Start a system design interview for the ${escapeHtml(role.title)} role at ${escapeHtml(role.company)}. Present a system design problem relevant to what this company builds. Let me drive the design — ask clarifying questions, push back on tradeoffs, probe scalability. Go.`;
    case 'mixed':
      return `Simulate a full interview loop for the ${escapeHtml(role.title)} role at ${escapeHtml(role.company)}. Start with a behavioral question, then move to technical, then system design. One question at a time. After each answer, give brief feedback. 5-6 questions total. Go.`;
    default:
      return `Interview me for the ${escapeHtml(role.title)} role at ${escapeHtml(role.company)}. One question at a time.`;
  }
}
