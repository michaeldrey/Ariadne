import { invoke, escapeHtml, renderMarkdown, toast } from '../app.js';

let currentRoleId = null;
let currentConversationId = null;
let unlisten = null;
let streamingMessageEl = null;
let pendingToolBubbles = new Map();

export async function openChat(role) {
  // Idempotent: if already open for this role, just focus input.
  if (currentRoleId === role.id) {
    document.getElementById('chat-input')?.focus();
    return;
  }

  // If open for a different role, tear down first.
  if (currentRoleId) await closeChat();

  currentRoleId = role.id;
  const drawer = document.getElementById('chat-drawer');
  drawer.classList.remove('chat-closed');
  drawer.classList.add('chat-open');

  drawer.innerHTML = `
    <div class="chat-header">
      <h4>Chat · ${escapeHtml(role.company)} — ${escapeHtml(role.title)}</h4>
      <button class="btn-icon" id="chat-close" title="Close chat">×</button>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="chat-empty">Loading…</div>
    </div>
    <div class="chat-input-area">
      <div class="chat-chips chat-chips-persistent">
        <button class="chat-chip" data-prompt="Tailor my resume for this role.">Tailor resume</button>
        <button class="chat-chip" data-prompt="Generate a research packet for this company and role.">Research company</button>
        <button class="chat-chip" data-prompt="Draft an intro message I could send to a hiring manager or recruiter for this role.">Draft outreach</button>
      </div>
      <div class="chat-input-row">
        <textarea id="chat-input" placeholder="Ask about this role…" rows="1"></textarea>
        <button class="btn btn-primary btn-sm chat-send-btn" id="chat-send">Send</button>
      </div>
      <div class="chat-status" id="chat-status"></div>
    </div>
  `;

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

  try {
    const conv = await invoke('get_or_create_conversation', { roleId: role.id });
    currentConversationId = conv.id;
    const messages = await invoke('list_messages', { conversationId: conv.id });
    renderMessages(messages);
  } catch (err) {
    setStatus(err.toString(), true);
  }

  await subscribeToEvents();
  input.focus();
}

export async function closeChat() {
  const drawer = document.getElementById('chat-drawer');
  if (!drawer) return;
  drawer.classList.remove('chat-open');
  drawer.classList.add('chat-closed');
  drawer.innerHTML = '';
  currentRoleId = null;
  currentConversationId = null;
  streamingMessageEl = null;
  pendingToolBubbles.clear();
  if (unlisten) {
    try { unlisten(); } catch {}
    unlisten = null;
  }
}

export function isChatOpenForRole(roleId) {
  return currentRoleId === roleId;
}

async function subscribeToEvents() {
  const { listen } = window.__TAURI__.event;
  if (unlisten) { try { unlisten(); } catch {} }
  unlisten = await listen('agent:event', (e) => handleEvent(e.payload));
}

function handleEvent(evt) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  switch (evt.type) {
    case 'turn_started': {
      // Clear empty-state if present.
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
      // Insert before the cursor so cursor stays at bottom.
      const cursor = bubble.querySelector('.chat-cursor');
      if (cursor) bubble.insertBefore(toolEl, cursor);
      else bubble.appendChild(toolEl);
      pendingToolBubbles.set(evt.tool_use_id, toolEl);
      // Close the current text accumulator so subsequent text starts fresh after the tool.
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
      // Informational; UI is built live, no action needed.
      break;
  }
}

function ensureTextAccumulator() {
  if (!streamingMessageEl) return;
  const bubble = streamingMessageEl.querySelector('.chat-bubble');
  if (!bubble) return;
  // Only one accumulator can be "active" at a time. Once a tool runs we close it.
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
  if (!text || !currentRoleId) return;

  // Optimistic user message.
  const container = document.getElementById('chat-messages');
  const empty = container?.querySelector('.chat-empty');
  if (empty) empty.remove();
  appendUserMessage(container, text);

  input.value = '';
  autoGrow(input);
  setStatus('Thinking…');

  try {
    await invoke('send_message', { roleId: currentRoleId, userText: text });
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
    container.innerHTML = `
      <div class="chat-empty">
        <p>Start a conversation about this role. Pick a suggestion below or ask anything.</p>
      </div>
    `;
    return;
  }

  // Map tool_use_id → tool_result block for assistant-tool pairing.
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
      if (textBlocks.length === 0) continue; // skip pure tool_result messages
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
