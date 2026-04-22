import { invoke, escapeHtml, formatDate, toast, showModal, closeModal, navigate } from '../app.js';

export async function renderContacts(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading contacts...</div>';

  const contacts = await invoke('list_contacts');

  container.innerHTML = `
    <div class="flex-between mb-16">
      <h2>Contacts (${contacts.length})</h2>
      <button class="btn btn-primary" id="btn-add-contact">+ Add Contact</button>
    </div>

    ${contacts.length > 0 ? `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Title</th>
              <th>Interactions</th>
              <th>Last Contact</th>
            </tr>
          </thead>
          <tbody>
            ${contacts.map(c => `
              <tr onclick="window.location.hash='#/contacts/${c.id}'">
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td>${escapeHtml(c.company) || '—'}</td>
                <td class="text-sm">${escapeHtml(c.title) || '—'}</td>
                <td class="mono">${c.interaction_count || 0}</td>
                <td class="text-muted text-sm">${c.last_interaction ? formatDate(c.last_interaction) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<div class="empty-state"><div class="icon">&#9734;</div><p>No contacts yet</p></div>'}
  `;

  document.getElementById('btn-add-contact').addEventListener('click', () => {
    showModal(`
      <h3>Add Contact</h3>
      <form id="add-contact-form">
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="contact-name" required placeholder="Full name" />
        </div>
        <div class="form-group">
          <label>Company</label>
          <input type="text" id="contact-company" placeholder="Company" />
        </div>
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="contact-title" placeholder="Job title" />
        </div>
        <div class="form-group">
          <label>Email</label>
          <input type="text" id="contact-email" placeholder="email@example.com" />
        </div>
        <div class="form-group">
          <label>LinkedIn URL</label>
          <input type="url" id="contact-linkedin" placeholder="https://linkedin.com/in/..." />
        </div>
        <div class="form-group">
          <label>Source</label>
          <input type="text" id="contact-source" placeholder="How do you know them?" />
        </div>
        <div class="btn-group mt-16">
          <button type="submit" class="btn btn-primary">Add Contact</button>
          <button type="button" class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
        </div>
      </form>
    `);

    document.getElementById('add-contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const contact = await invoke('create_contact', {
          data: {
            name: document.getElementById('contact-name').value,
            company: document.getElementById('contact-company').value || null,
            title: document.getElementById('contact-title').value || null,
            email: document.getElementById('contact-email').value || null,
            linkedin_url: document.getElementById('contact-linkedin').value || null,
            source: document.getElementById('contact-source').value || null,
            introduced_by: null,
            notes: null,
          }
        });
        closeModal();
        toast('Contact added', 'success');
        renderContacts(container);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });
}

export async function renderContactDetail(container, id) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading contact...</div>';

  let contact;
  try {
    contact = await invoke('get_contact', { id });
  } catch {
    container.innerHTML = '<div class="empty-state"><p>Contact not found</p></div>';
    return;
  }

  const interactions = await invoke('list_interactions', { contactId: id });

  container.innerHTML = `
    <a href="#/contacts" class="text-muted text-sm" style="text-decoration:none">&larr; Back to Contacts</a>

    <div class="detail-header mt-16">
      <div>
        <h2 class="detail-title">${escapeHtml(contact.name)}</h2>
        <div class="detail-subtitle">
          ${contact.title ? escapeHtml(contact.title) : ''}
          ${contact.title && contact.company ? ' at ' : ''}
          ${contact.company ? escapeHtml(contact.company) : ''}
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-sm" id="btn-log-interaction">Log Interaction</button>
        <button class="btn btn-danger btn-sm" id="btn-delete-contact">Delete</button>
      </div>
    </div>

    <div class="detail-meta">
      ${contact.email ? `<span class="meta-item">${escapeHtml(contact.email)}</span>` : ''}
      ${contact.linkedin_url ? `<a href="${escapeHtml(contact.linkedin_url)}" target="_blank" class="meta-item" style="color:var(--accent)">LinkedIn &nearr;</a>` : ''}
      ${contact.source ? `<span class="meta-item">Source: ${escapeHtml(contact.source)}</span>` : ''}
      <span class="meta-item">Added: ${formatDate(contact.added_date)}</span>
    </div>

    ${contact.notes ? `
      <div class="card mb-16">
        <h4>Notes</h4>
        <p class="text-sm">${escapeHtml(contact.notes)}</p>
      </div>
    ` : ''}

    <div class="card">
      <h3>Interactions (${interactions.length})</h3>
      ${interactions.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            ${interactions.map(ix => `
              <tr>
                <td class="text-sm mono">${formatDate(ix.interaction_date)}</td>
                <td><span class="badge badge-sourced">${escapeHtml(ix.interaction_type)}</span></td>
                <td>${escapeHtml(ix.summary)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<p class="text-muted text-sm">No interactions logged yet</p>'}
    </div>
  `;

  // Log interaction
  document.getElementById('btn-log-interaction').addEventListener('click', () => {
    showModal(`
      <h3>Log Interaction with ${escapeHtml(contact.name)}</h3>
      <form id="log-interaction-form">
        <div class="form-group">
          <label>Type</label>
          <select id="ix-type" required>
            <option value="email">Email</option>
            <option value="call">Call</option>
            <option value="message">Message</option>
            <option value="meeting">Meeting</option>
            <option value="linkedin">LinkedIn</option>
            <option value="coffee">Coffee</option>
          </select>
        </div>
        <div class="form-group">
          <label>Summary</label>
          <input type="text" id="ix-summary" required placeholder="Brief description" />
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="ix-date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <div class="btn-group mt-16">
          <button type="submit" class="btn btn-primary">Log</button>
          <button type="button" class="btn" onclick="document.getElementById('modal-overlay').classList.add('hidden')">Cancel</button>
        </div>
      </form>
    `);

    document.getElementById('log-interaction-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await invoke('add_interaction', {
          contactId: id,
          data: {
            interaction_type: document.getElementById('ix-type').value,
            summary: document.getElementById('ix-summary').value,
            interaction_date: document.getElementById('ix-date').value || null,
            linked_roles: null,
          }
        });
        closeModal();
        toast('Interaction logged', 'success');
        renderContactDetail(container, id);
      } catch (err) { toast(err.toString(), 'error'); }
    });
  });

  // Delete
  document.getElementById('btn-delete-contact').addEventListener('click', async () => {
    if (!confirm(`Delete ${contact.name}? This will also delete their interaction history.`)) return;
    try {
      await invoke('delete_contact', { id });
      toast('Contact deleted', 'success');
      navigate('#/contacts');
    } catch (err) { toast(err.toString(), 'error'); }
  });
}
