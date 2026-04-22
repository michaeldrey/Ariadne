import { invoke, escapeHtml, renderMarkdown, toast } from '../app.js';

// Scope:  { type: 'role', role: {id, company, title} } | { type: 'profile' }
let currentScope = null;
let currentConversations = [];  // list of {id, scope_type, role_id, title, created_at, updated_at}
let currentConversationId = null;
let unlisten = null;
let streamingMessageEl = null;
let pendingToolBubbles = new Map();

// ── Public API ──

export async function openChat(role) {
  return openScope({ type: 'role', role });
}

export async function openChatAndSend(role, text) {
  await openChat(role);
  return sendAfterOpen(text);
}

export async function openProfileChat() {
  return openScope({ type: 'profile' });
}

export async function openProfileChatAndSend(text) {
  await openProfileChat();
  return sendAfterOpen(text);
}

export async function closeChat() {
  const drawer = document.getElementById('chat-drawer');
  if (!drawer) return;
  drawer.classList.remove('chat-open');
  drawer.classList.add('chat-closed');
  drawer.innerHTML = '';
  currentScope = null;
  currentConversations = [];
  currentConversationId = null;
  streamingMessageEl = null;
  pendingToolBubbles.clear();
  if (unlisten) {
    try { unlisten(); } catch {}
    unlisten = null;
  }
}

export function isChatOpenForRole(roleId) {
  return currentScope?.type === 'role' && currentScope.role.id === roleId;
}

export function getCurrentChatScopeType() {
  return currentScope?.type || null;
}

// ── Internals ──

async function openScope(scope) {
  if (sameScope(currentScope, scope)) {
    document.getElementById('chat-input')?.focus();
    return;
  }
  if (currentScope) await closeChat();

  currentScope = scope;
  const drawer = document.getElementById('chat-drawer');
  drawer.classList.remove('chat-closed');
  drawer.classList.add('chat-open');

  drawer.innerHTML = renderShell(scope);
  wireShellHandlers(drawer);

  try {
    await loadConversations();
    if (currentConversations.length === 0) {
      // Auto-create a first thread so the user has something to send to.
      const conv = await invoke('create_conversation', { scopeType: scope.type, roleId: scopeRoleId(scope), title: null });
      currentConversations = [conv];
    }
    currentConversationId = currentConversations[0].id;
    renderThreadPicker();
    const messages = await invoke('list_messages', { conversationId: currentConversationId });
    renderMessages(messages);
  } catch (err) {
    setStatus(err.toString(), true);
  }

  await subscribeToEvents();
  document.getElementById('chat-input')?.focus();
}

function scopeRoleId(scope) {
  return scope.type === 'role' ? scope.role.id : null;
}

async function loadConversations() {
  const scopeType = currentScope.type;
  const roleId = scopeRoleId(currentScope);
  currentConversations = await invoke('list_conversations', { scopeType, roleId });
}

function renderShell(scope) {
  const header = scope.type === 'role'
    ? `${escapeHtml(scope.role.company)} — ${escapeHtml(scope.role.title)}`
    : 'Profile Coach';

  const chips = scope.type === 'role'
    ? [
        { label: 'Tailor resume', prompt: 'Tailor my resume for this role.' },
        { label: 'Research company', prompt: 'Generate a research packet for this company and role.' },
        { label: 'Draft outreach', prompt: 'Draft an intro message I could send to a hiring manager or recruiter for this role.' },
      ]
    : [
        { label: 'Build STAR stories', prompt: 'Interview me to build STAR stories from my resume. Ask one focused question at a time.' },
        { label: 'Refine search criteria', prompt: 'Help me clarify my search criteria — target companies, level, comp, must-haves, dealbreakers.' },
        { label: 'Update profile about', prompt: "Help me write a tight profile 'about' section — background, career arc, what I'm looking for next." },
      ];

  const placeholder = scope.type === 'role'
    ? 'Ask about this role…'
    : 'Ask about your profile, stories, or search…';

  return `
    <div class="chat-header">
      <h4>${header}</h4>
      <button class="btn-icon" id="chat-close" title="Close chat">×</button>
    </div>
    <div class="chat-thread-bar" id="chat-thread-bar"></div>
    <div class="chat-messages" id="chat-messages">
      <div class="chat-empty">Loading…</div>
    </div>
    <div class="chat-input-area">
      <div class="chat-chips chat-chips-persistent">
        ${chips.map(c => `<button class="chat-chip" data-prompt="${escapeHtml(c.prompt)}">${escapeHtml(c.label)}</button>`).join('')}
      </div>
      <div class="chat-input-row">
        <textarea id="chat-input" placeholder="${placeholder}" rows="1"></textarea>
        <button class="btn btn-primary btn-sm chat-send-btn" id="chat-send">Send</button>
      </div>
      <div class="chat-status" id="chat-status"></div>
    </div>
  `;
}

function wireShellHandlers(drawer) {
  document.getElementById('chat-close').addEventListener('click', closeChat);
  document.getElementById('chat-send').addEventListener('click', sendCurrent);

  drawer.querySelectorAll('.chat-chips-persistent .chat-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('chat-input');
      input.value = btn.dataset.prompt;
      input.focus();
      autoGrow(input);
    });
  });

  const input = document.getElementById('chat-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });
  input.addEventListener('input', () => autoGrow(input));
}

function renderThreadPicker() {
  const bar = document.getElementById('chat-thread-bar');
  if (!bar) return;

  const options = currentConversations.map(c => {
    const label = convDisplayTitle(c);
    const selected = c.id === currentConversationId ? 'selected' : '';
    return `<option value="${c.id}" ${selected}>${escapeHtml(label)}</option>`;
  }).join('');

  bar.innerHTML = `
    <select id="chat-thread-select" title="Switch thread">
      ${options}
    </select>
    <button class="btn-icon" id="chat-thread-new" title="New thread">＋</button>
    <button class="btn-icon" id="chat-thread-rename" title="Rename thread">✎</button>
    <button class="btn-icon" id="chat-thread-delete" title="Delete thread">🗑</button>
  `;

  document.getElementById('chat-thread-select').addEventListener('change', (e) => {
    switchThread(parseInt(e.target.value, 10));
  });
  document.getElementById('chat-thread-new').addEventListener('click', newThread);
  document.getElementById('chat-thread-rename').addEventListener('click', renameCurrentThread);
  document.getElementById('chat-thread-delete').addEventListener('click', deleteCurrentThread);
}

function convDisplayTitle(c) {
  if (c.title && c.title.trim()) return c.title;
  // Fallback: compact created_at like "Apr 21 1:15 PM"
  try {
    const d = new Date(c.created_at + 'Z');
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `New chat · ${date} ${time}`;
  } catch {
    return 'New chat';
  }
}

async function switchThread(conversationId) {
  if (conversationId === currentConversationId) return;
  currentConversationId = conversationId;
  const messages = await invoke('list_messages', { conversationId });
  renderMessages(messages);
  // Reflect selection in dropdown (in case call came from elsewhere).
  const sel = document.getElementById('chat-thread-select');
  if (sel) sel.value = String(conversationId);
}

async function newThread() {
  try {
    const conv = await invoke('create_conversation', {
      scopeType: currentScope.type,
      roleId: scopeRoleId(currentScope),
      title: null,
    });
    currentConversations = [conv, ...currentConversations];
    currentConversationId = conv.id;
    renderThreadPicker();
    renderMessages([]);
    document.getElementById('chat-input')?.focus();
  } catch (err) {
    toast(err.toString(), 'error');
  }
}

async function renameCurrentThread() {
  const current = currentConversations.find(c => c.id === currentConversationId);
  const existing = current?.title || '';
  const next = prompt('Rename thread', existing);
  if (next === null) return;
  const title = next.trim();
  try {
    await invoke('rename_conversation', { conversationId: currentConversationId, title: title || '' });
    if (current) current.title = title || null;
    renderThreadPicker();
  } catch (err) {
    toast(err.toString(), 'error');
  }
}

async function deleteCurrentThread() {
  const current = currentConversations.find(c => c.id === currentConversationId);
  const label = current ? convDisplayTitle(current) : 'this thread';
  if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
  try {
    await invoke('delete_conversation', { conversationId: currentConversationId });
    currentConversations = currentConversations.filter(c => c.id !== currentConversationId);
    if (currentConversations.length === 0) {
      // Create a fresh empty thread so the drawer is never in a no-thread state.
      const conv = await invoke('create_conversation', {
        scopeType: currentScope.type,
        roleId: scopeRoleId(currentScope),
        title: null,
      });
      currentConversations = [conv];
    }
    currentConversationId = currentConversations[0].id;
    renderThreadPicker();
    const messages = await invoke('list_messages', { conversationId: currentConversationId });
    renderMessages(messages);
    toast('Thread deleted', 'success');
  } catch (err) {
    toast(err.toString(), 'error');
  }
}

function sameScope(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'role') return a.role.id === b.role.id;
  return true;
}

async function sendAfterOpen(text) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.value = text;
  await new Promise(r => setTimeout(r, 0));
  sendCurrent();
}

async function subscribeToEvents() {
  const { listen } = window.__TAURI__.event;
  if (unlisten) { try { unlisten(); } catch {} }
  unlisten = await listen('agent:event', (e) => handleEvent(e.payload));
}

function handleEvent(evt) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // Filter events to the currently-active thread so other conversations
  // finishing in the background don't scribble into this view.
  if (evt.conversation_id != null && currentConversationId != null
      && evt.conversation_id !== currentConversationId) {
    return;
  }

  switch (evt.type) {
    case 'turn_started': {
      const empty = container.querySelector('.chat-empty');
      if (empty) empty.remove();
      streamingMessageEl = document.createElement('div');
      streamingMessageEl.className = 'chat-msg assistant';
      streamingMessageEl.innerHTML = `
        <div class="chat-msg-role">Claude</div>
        <div class="chat-bubble"><span class="chat-cursor"></span></div>
      `;
      container.appendChild(streamingMessageEl);
      pendingToolBubbles.clear();
      scrollToBottom();
      break;
    }

    case 'text_start':
      ensureTextAccumulator();
      break;

    case 'text_delta':
      appendStreamingText(evt.text);
      scrollToBottom();
      break;

    case 'tool_call_start': {
      if (!streamingMessageEl) break;
      const bubble = streamingMessageEl.querySelector('.chat-bubble');
      const toolEl = document.createElement('div');
      toolEl.className = 'tool-bubble';
      toolEl.innerHTML = `
        <div class="tool-header">
          <span class="tool-icon">⚙</span>
          <span class="tool-name">${escapeHtml(evt.name)}</span>
          <span class="tool-summary">running…</span>
        </div>
      `;
      const cursor = bubble.querySelector('.chat-cursor');
      if (cursor) bubble.insertBefore(toolEl, cursor);
      else bubble.appendChild(toolEl);
      pendingToolBubbles.set(evt.tool_use_id, toolEl);
      const acc = bubble.querySelector('.text-accumulator.active');
      if (acc) acc.classList.remove('active');
      scrollToBottom();
      break;
    }

    case 'tool_call_result': {
      const toolEl = pendingToolBubbles.get(evt.tool_use_id);
      if (!toolEl) break;
      toolEl.classList.toggle('error', !evt.ok);
      toolEl.innerHTML = renderToolHeader(evt.name, evt.summary, evt.ok, evt.input);
      wireToolToggle(toolEl);
      pendingToolBubbles.delete(evt.tool_use_id);
      scrollToBottom();
      break;
    }

    case 'turn_done': {
      removeStreamingCursor();
      streamingMessageEl = null;
      setStatus('');
      break;
    }

    case 'error': {
      removeStreamingCursor();
      streamingMessageEl = null;
      setStatus(evt.message, true);
      break;
    }

    case 'user_message_saved':
    case 'assistant_message_saved':
    case 'tool_results_saved':
      break;
  }
}

function ensureTextAccumulator() {
  if (!streamingMessageEl) return;
  const bubble = streamingMessageEl.querySelector('.chat-bubble');
  if (!bubble) return;
  if (bubble.querySelector('.text-accumulator.active')) return;
  const cursor = bubble.querySelector('.chat-cursor');
  const acc = document.createElement('div');
  acc.className = 'text-accumulator active markdown-content';
  acc.dataset.raw = '';
  if (cursor) bubble.insertBefore(acc, cursor);
  else bubble.appendChild(acc);
}

function appendStreamingText(text) {
  ensureTextAccumulator();
  const acc = streamingMessageEl?.querySelector('.text-accumulator.active');
  if (!acc) return;
  acc.dataset.raw = (acc.dataset.raw || '') + text;
  acc.innerHTML = renderMarkdown(acc.dataset.raw);
}

function removeStreamingCursor() {
  const cursor = streamingMessageEl?.querySelector('.chat-cursor');
  if (cursor) cursor.remove();
  streamingMessageEl?.querySelectorAll('.text-accumulator').forEach(el => el.classList.remove('active'));
}

async function sendCurrent() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text || !currentConversationId) return;

  const container = document.getElementById('chat-messages');
  const empty = container?.querySelector('.chat-empty');
  if (empty) empty.remove();
  appendUserMessage(container, text);

  // If this is the first user message of an untitled thread, auto-title it
  // from the prompt so the picker dropdown shows something meaningful.
  const current = currentConversations.find(c => c.id === currentConversationId);
  if (current && !current.title) {
    const autoTitle = text.slice(0, 50) + (text.length > 50 ? '…' : '');
    try {
      await invoke('rename_conversation', { conversationId: currentConversationId, title: autoTitle });
      current.title = autoTitle;
      renderThreadPicker();
    } catch { /* best-effort */ }
  }

  input.value = '';
  autoGrow(input);
  setStatus('Thinking…');

  try {
    await invoke('send_to_conversation', { conversationId: currentConversationId, userText: text });
  } catch (err) {
    setStatus(err.toString(), true);
  }
}

function appendUserMessage(container, text) {
  const el = document.createElement('div');
  el.className = 'chat-msg user';
  el.innerHTML = `
    <div class="chat-msg-role">You</div>
    <div class="chat-bubble">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
  `;
  container.appendChild(el);
  scrollToBottom();
}

function renderMessages(messages) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';

  if (!messages || messages.length === 0) {
    const hint = currentScope?.type === 'profile'
      ? 'Talk to your Profile Coach. Try a suggestion below, or ask anything.'
      : 'Start a conversation about this role. Pick a suggestion below or ask anything.';
    container.innerHTML = `<div class="chat-empty"><p>${hint}</p></div>`;
    return;
  }

  const toolResults = new Map();
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      for (const b of blocks) {
        if (b.type === 'tool_result') toolResults.set(b.tool_use_id, b);
      }
    }
  }

  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [];

    if (m.role === 'user') {
      const textBlocks = blocks.filter(b => b.type === 'text');
      if (textBlocks.length === 0) continue;
      const el = document.createElement('div');
      el.className = 'chat-msg user';
      el.innerHTML = `
        <div class="chat-msg-role">You</div>
        <div class="chat-bubble">${textBlocks.map(b => escapeHtml(b.text).replace(/\n/g, '<br>')).join('<br>')}</div>
      `;
      container.appendChild(el);
    } else {
      const el = document.createElement('div');
      el.className = 'chat-msg assistant';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      for (const b of blocks) {
        if (b.type === 'text') {
          const span = document.createElement('div');
          span.className = 'markdown-content';
          span.innerHTML = renderMarkdown(b.text);
          bubble.appendChild(span);
        } else if (b.type === 'tool_use') {
          const result = toolResults.get(b.id);
          const ok = result ? !result.is_error : false;
          const summary = result
            ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
            : 'pending';
          const toolEl = document.createElement('div');
          toolEl.className = 'tool-bubble' + (ok ? '' : (result ? ' error' : ''));
          toolEl.innerHTML = renderToolHeader(b.name, summary, ok, b.input);
          wireToolToggle(toolEl);
          bubble.appendChild(toolEl);
        }
      }
      el.innerHTML = `<div class="chat-msg-role">Claude</div>`;
      el.appendChild(bubble);
      container.appendChild(el);
    }
  }

  scrollToBottom();
}

function renderToolHeader(name, summary, ok, input) {
  const icon = ok ? '✓' : '✗';
  const inputStr = JSON.stringify(input ?? {}, null, 2);
  const summaryShort = (summary || '').slice(0, 80);
  return `
    <div class="tool-header" data-toggle-details>
      <span class="tool-icon">${icon}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-summary">${escapeHtml(summaryShort)}</span>
    </div>
    <div class="tool-details hidden">${escapeHtml(inputStr)}</div>
  `;
}

function wireToolToggle(toolEl) {
  const header = toolEl.querySelector('[data-toggle-details]');
  const details = toolEl.querySelector('.tool-details');
  if (!header || !details) return;
  header.style.cursor = 'pointer';
  header.addEventListener('click', () => details.classList.toggle('hidden'));
}

function scrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function setStatus(text, error = false) {
  const el = document.getElementById('chat-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!error);
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(120, el.scrollHeight) + 'px';
}
