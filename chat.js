/**
 * College ChatBot — Frontend Logic
 * Handles API communication, message rendering, and UI state.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let activeConvoId  = null;
let isLoading      = false;
let lastUserMessage = '';

// ── DOM references ────────────────────────────────────────────────────────────
const messagesEl        = document.getElementById('messages');
const messagesWrapper   = document.getElementById('messagesWrapper');
const userInput         = document.getElementById('userInput');
const btnSend           = document.getElementById('btnSend');
const typingIndicator   = document.getElementById('typingIndicator');
const welcomeScreen     = document.getElementById('welcomeScreen');
const convoList         = document.getElementById('convoList');
const userNameDisplay   = document.getElementById('userNameDisplay');
const userAvatar        = document.querySelector('.user-avatar');
const charCount         = document.getElementById('charCount');
const renameModal       = document.getElementById('renameModal');
const nameInput         = document.getElementById('nameInput');
const btnNewChat        = document.getElementById('btnNewChat');
const btnRename         = document.getElementById('btnRename');
const btnModalCancel    = document.getElementById('btnModalCancel');
const btnModalConfirm   = document.getElementById('btnModalConfirm');
const sidebarToggle     = document.getElementById('sidebarToggle');
const sidebar           = document.getElementById('sidebar');

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function init() {
  await loadUser();
  await loadConversations();
  setupEvents();
})();

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Server error');
  return data;
}

// ── User ──────────────────────────────────────────────────────────────────────
async function loadUser() {
  try {
    const { user } = await api('/api/user');
    updateUserUI(user.username);
  } catch { /* non-fatal */ }
}

function updateUserUI(name) {
  const display = name || 'Anonymous';
  userNameDisplay.textContent = display;
  userAvatar.textContent = display[0].toUpperCase();
}

async function saveUsername() {
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    const { user } = await api('/api/user/name', 'POST', { username: name });
    updateUserUI(user.username);
    closeModal();
  } catch (e) {
    showToast(e.message);
  }
}

// ── Conversations ─────────────────────────────────────────────────────────────
async function loadConversations() {
  try {
    const { conversations } = await api('/api/conversations');
    renderConvoList(conversations);
  } catch { /* non-fatal */ }
}

function renderConvoList(convos) {
  if (!convos.length) {
    convoList.innerHTML = '<li class="convo-empty">No conversations yet</li>';
    return;
  }
  convoList.innerHTML = convos.map(c => `
    <li class="convo-item${c.id === activeConvoId ? ' active' : ''}"
        data-id="${c.id}"
        title="${escHtml(c.title || 'Untitled')}">
      <span class="convo-title">${escHtml(c.title || 'Untitled')}</span>
      <button class="convo-delete" data-id="${c.id}" title="Delete">✕</button>
    </li>
  `).join('');
}

async function selectConversation(id) {
  if (activeConvoId === id) return;
  activeConvoId = id;

  try {
    const { conversation } = await api(`/api/conversations/${id}`);
    showChatView();
    messagesEl.innerHTML = '';

    conversation.messages.forEach(m => appendMessage(m.role, m.content, false));
    scrollToBottom(false);
    await loadConversations();   // refresh sidebar highlight
  } catch (e) {
    showToast(e.message);
  }
}

async function createNewConversation() {
  try {
    const { conversation } = await api('/api/conversations', 'POST');
    activeConvoId = conversation.id;
    showChatView();
    messagesEl.innerHTML = '';
    await loadConversations();
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  try {
    await api(`/api/conversations/${id}`, 'DELETE');
    if (activeConvoId === id) {
      activeConvoId = null;
      showWelcomeView();
    }
    await loadConversations();
  } catch (e) {
    showToast(e.message);
  }
}

// ── Sending messages ──────────────────────────────────────────────────────────
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text || isLoading) return;

  lastUserMessage = text;   // store for copy feature
  isLoading = true;
  btnSend.disabled = true;
  userInput.value  = '';
  updateCharCount();
  autoResize();

  // If no active conversation, create one on the fly
  if (!activeConvoId) {
    showChatView();
    messagesEl.innerHTML = '';
  }

  appendMessage('user', text);
  showTyping(true);
  scrollToBottom();

  try {
    const data = await api('/api/chat', 'POST', {
      message:         text,
      conversation_id: activeConvoId,
    });

    activeConvoId = data.conversation_id;
    showTyping(false);
    appendMessage('assistant', data.reply, true, lastUserMessage);
    scrollToBottom();
    await loadConversations();
  } catch (e) {
    showTyping(false);
    appendMessage('assistant', `⚠️ ${e.message}`);
  } finally {
    isLoading        = false;
    btnSend.disabled = !userInput.value.trim();
    userInput.focus();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function appendMessage(role, content, animate = true, question = '') {
  const div    = document.createElement('div');
  div.className = `message ${role}${animate ? '' : ' no-anim'}`;

  const icon = role === 'user' ? '👤' : '🎓';

  let copyBtn = '';
  if (role === 'assistant') {
    copyBtn = `<button class="btn-copy" title="Copy question &amp; answer">⎘ Copy</button>`;
  }

  div.innerHTML = `
    <div class="msg-avatar">${icon}</div>
    <div class="msg-body">
      <div class="msg-bubble">${formatContent(content)}</div>
      ${copyBtn}
    </div>
  `;

  if (role === 'assistant') {
    div.querySelector('.btn-copy').addEventListener('click', () => {
      const copyText = question
        ? `Q: ${question}\n\nA: ${content}`
        : `A: ${content}`;
      navigator.clipboard.writeText(copyText).then(() => {
        const btn = div.querySelector('.btn-copy');
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '⎘ Copy';
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => showToast('Copy failed — please copy manually.'));
    });
  }

  messagesEl.appendChild(div);
}

/** Convert Markdown-like patterns to HTML */
function formatContent(text) {
  let html = escHtml(text);

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold (**text**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (*text*)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Numbered list items (1. 2. 3. …)
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li class="num-item">$1</li>');
  // Bullet list items (- or •)
  html = html.replace(/^[-•]\s+(.+)$/gm, '<li class="bul-item">$1</li>');

  // Wrap consecutive <li> tags in <ol> or <ul>
  html = html.replace(/(<li class="num-item">[\s\S]*?<\/li>(\n|<br>)*)+/g, m =>
    '<ol>' + m.replace(/<br>/g, '') + '</ol>');
  html = html.replace(/(<li class="bul-item">[\s\S]*?<\/li>(\n|<br>)*)+/g, m =>
    '<ul>' + m.replace(/<br>/g, '') + '</ul>');

  // Line breaks (remaining \n not inside lists)
  html = html.replace(/\n/g, '<br>');

  return html;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── View helpers ──────────────────────────────────────────────────────────────
function showChatView() {
  welcomeScreen.style.display   = 'none';
  messagesWrapper.classList.add('visible');
}

function showWelcomeView() {
  welcomeScreen.style.display = '';
  messagesWrapper.classList.remove('visible');
  messagesEl.innerHTML = '';
}

function showTyping(show) {
  typingIndicator.classList.toggle('hidden', !show);
  if (show) scrollToBottom();
}

function scrollToBottom(smooth = true) {
  const el = messagesWrapper;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function updateCharCount() {
  const len = userInput.value.length;
  charCount.textContent = len;
  charCount.style.color = len > 3800 ? '#ff9999' : '';
}

function autoResize() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 180) + 'px';
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal() {
  renameModal.classList.remove('hidden');
  nameInput.value = userNameDisplay.textContent === 'Anonymous' ? '' : userNameDisplay.textContent;
  nameInput.focus();
}

function closeModal() {
  renameModal.classList.add('hidden');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.createElement('div');
  toast.className   = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Events ────────────────────────────────────────────────────────────────────
function setupEvents() {

  // Send on button click
  btnSend.addEventListener('click', sendMessage);

  // Textarea: Enter to send, Shift+Enter for newline
  userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  userInput.addEventListener('input', () => {
    autoResize();
    updateCharCount();
    btnSend.disabled = !userInput.value.trim();
  });

  // Suggestion chips
  document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      userInput.value = chip.dataset.text;
      userInput.dispatchEvent(new Event('input'));
      userInput.focus();
    });
  });

  // New chat button
  btnNewChat.addEventListener('click', createNewConversation);

  // Conversation list (delegation)
  convoList.addEventListener('click', e => {
    const del  = e.target.closest('.convo-delete');
    const item = e.target.closest('.convo-item');
    if (del)  { e.stopPropagation(); deleteConversation(+del.dataset.id); return; }
    if (item) { selectConversation(+item.dataset.id); closeSidebar(); }
  });

  // Rename modal
  btnRename.addEventListener('click',       openModal);
  btnModalCancel.addEventListener('click',  closeModal);
  btnModalConfirm.addEventListener('click', saveUsername);
  renameModal.addEventListener('click', e => { if (e.target === renameModal) closeModal(); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveUsername(); });

  // Mobile sidebar
  sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

  function closeSidebar() { sidebar.classList.remove('open'); }
  document.addEventListener('click', e => {
    if (!sidebar.contains(e.target) && !sidebarToggle.contains(e.target)) closeSidebar();
  });
}
