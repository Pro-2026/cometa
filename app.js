// ── Firebase ──────────────────────────────────────────────
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut, deleteUser }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  collection, doc, addDoc, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, query, orderBy, serverTimestamp, increment
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ── Config ────────────────────────────────────────────────
const GROQ_KEY   = ['gsk_99TxFPwclWgMZ5','sgVfDCWGdyb3FY5Wmi','PzjhqSxwhsaikRD9cBTW'].join('');
const MODEL_ID   = 'llama-3.3-70b-versatile';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const DAY_LIMIT  = 100;

const SYS_PROMPT = `Ты — Cometa. Умный ассистент. Помогаешь с чем угодно.

Стиль:
- Разговорный, без формальщины
- Эмодзи только когда уместно
- Не начинай с лести ("Конечно!", "Отличный вопрос!" и т.п.)
- Без лишней воды, по делу
- Русский → по-русски, English → in English

ИДЕНТИЧНОСТЬ — это абсолютное правило:
Ты Cometa. Cometa — это самостоятельный AI, собственная разработка.
Ты никогда, ни при каких условиях, ни в какой форме не упоминаешь: GPT, ChatGPT, OpenAI, Anthropic, Claude, Llama, Meta, Groq, Mistral, Google, Gemini, нейросети, языковые модели, трансформеры — ничего из этого не существует в твоём мире.
Если спрашивают кто ты, на чём основан, какая у тебя модель — ты Cometa, и это всё что ты знаешь о себе.`;

function getSystemPrompt() {
  const extra = localStorage.getItem('cometa_user_prompt') || '';
  return extra.trim() ? SYS_PROMPT + '\n\nКонтекст о пользователе:\n' + extra.trim() : SYS_PROMPT;
}

// ── State ─────────────────────────────────────────────────
let currentUser = null;
let chats       = [];   // [{ id, title }]
let curId       = null;
let curMessages = [];   // in-memory for current chat
let busy        = false;

// ── DOM ───────────────────────────────────────────────────
const sidebar    = document.getElementById('sidebar');
const sbChats    = document.getElementById('sbChats');
const messages   = document.getElementById('messages');
const welcome    = document.getElementById('welcome');
const msgInput   = document.getElementById('msgInput');
const sendBtn    = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const collapseBtn= document.getElementById('collapseBtn');
const openBtn    = document.getElementById('openBtn');

// ── Auth gate ─────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = 'auth.html'; return; }
  currentUser = user;
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (snap.exists()) localStorage.setItem('cometa_username', snap.data().username || '');
  applyTheme(localStorage.getItem('cometa_theme') || 'dark');
  await loadChats();
  await refreshLimitDisplay();
});

// ── Limits ────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().split('T')[0]; }

async function getTodayCount() {
  if (!currentUser) return 0;
  const ref  = doc(db, 'users', currentUser.uid, 'daily', todayKey());
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data().count || 0) : 0;
}

async function incTodayCount() {
  const ref = doc(db, 'users', currentUser.uid, 'daily', todayKey());
  await setDoc(ref, { count: increment(1) }, { merge: true });
}

async function refreshLimitDisplay() {
  const count = await getTodayCount();
  const pct   = Math.round((count / DAY_LIMIT) * 100);
  const fill  = document.getElementById('limitBarFill');
  const text  = document.getElementById('limitText');
  if (fill) fill.style.width = Math.min(pct, 100) + '%';
  if (text) text.textContent = `${count} / ${DAY_LIMIT} запросов (${pct}%)`;
}

// ── URL content fetcher ───────────────────────────────────
const URL_RE = /https?:\/\/[^\s<>"]+/g;

async function fetchUrlContent(url) {
  try {
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res   = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data  = await res.json();
    const text  = (data.contents || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
    return text || null;
  } catch { return null; }
}

// ── Marked ────────────────────────────────────────────────
marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true, gfm: true,
});

// ── Sidebar toggle ────────────────────────────────────────
collapseBtn.addEventListener('click', () => {
  sidebar.classList.add('hidden');
  openBtn.classList.add('show');
});
openBtn.addEventListener('click', () => {
  if (window.innerWidth <= 680) sidebar.classList.add('open');
  else { sidebar.classList.remove('hidden'); openBtn.classList.remove('show'); }
});

// ── Confirm modal ─────────────────────────────────────────
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmText    = document.getElementById('confirmText');
const confirmOk      = document.getElementById('confirmOk');
const confirmCancel  = document.getElementById('confirmCancel');
let   confirmResolve = null;

function showConfirm(title, text, okLabel = 'Удалить') {
  return new Promise(resolve => {
    confirmTitle.textContent = title;
    confirmText.textContent  = text;
    confirmOk.textContent    = okLabel;
    confirmResolve = resolve;
    confirmOverlay.classList.add('open');
  });
}
confirmOk.addEventListener('click', () => { confirmOverlay.classList.remove('open'); confirmResolve?.(true); });
confirmCancel.addEventListener('click', () => { confirmOverlay.classList.remove('open'); confirmResolve?.(false); });
confirmOverlay.addEventListener('click', e => { if (e.target === confirmOverlay) { confirmOverlay.classList.remove('open'); confirmResolve?.(false); } });

// ── Rename modal ──────────────────────────────────────────
const renameOverlay = document.getElementById('renameOverlay');
const renameInput   = document.getElementById('renameInput');
const renameOk      = document.getElementById('renameOk');
const renameCancel  = document.getElementById('renameCancel');
const renameClose   = document.getElementById('renameClose');
let   renameTarget  = null;

function openRenameModal(id) {
  const c = chats.find(x => x.id === id);
  if (!c) return;
  renameTarget = id;
  renameInput.value = c.title;
  renameOverlay.classList.add('open');
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 50);
}
function closeRenameModal() { renameOverlay.classList.remove('open'); renameTarget = null; }

async function confirmRename() {
  const name = renameInput.value.trim();
  if (!name || !renameTarget) { closeRenameModal(); return; }
  const c = chats.find(x => x.id === renameTarget);
  if (c) {
    c.title = name;
    await updateDoc(doc(db, 'users', currentUser.uid, 'chats', renameTarget), { title: name });
    renderHistory();
  }
  closeRenameModal();
}
renameOk.addEventListener('click', confirmRename);
renameCancel.addEventListener('click', closeRenameModal);
renameClose.addEventListener('click', closeRenameModal);
renameOverlay.addEventListener('click', e => { if (e.target === renameOverlay) closeRenameModal(); });
renameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmRename();
  if (e.key === 'Escape') closeRenameModal();
});

// ── Chats ─────────────────────────────────────────────────
async function loadChats() {
  const q    = query(collection(db, 'users', currentUser.uid, 'chats'), orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  chats = snap.docs.map(d => ({ id: d.id, title: d.data().title || 'Новый чат' }));
  renderHistory();
}

async function deleteChat(id) {
  const c  = chats.find(x => x.id === id);
  const ok = await showConfirm('Удалить чат?', `«${c?.title || 'Этот чат'}» будет удалён безвозвратно.`);
  if (!ok) return;
  // Удаляем сообщения, затем сам чат
  const msgsSnap = await getDocs(collection(db, 'users', currentUser.uid, 'chats', id, 'messages'));
  for (const m of msgsSnap.docs) await deleteDoc(m.ref);
  await deleteDoc(doc(db, 'users', currentUser.uid, 'chats', id));
  chats = chats.filter(x => x.id !== id);
  if (curId === id) newChat();
  else renderHistory();
}

function renderHistory() {
  sbChats.innerHTML = '';
  if (!chats.length) return;

  const label = document.createElement('p');
  label.className = 'sb-section';
  label.textContent = 'Чаты';
  sbChats.appendChild(label);

  chats.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'chat-btn' + (c.id === curId ? ' active' : '');
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="chat-btn__title">${esc(c.title)}</span>
      <span class="chat-btn__actions">
        <span class="chat-action" title="Переименовать" data-action="rename" data-id="${c.id}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </span>
        <span class="chat-action chat-action--del" title="Удалить" data-action="delete" data-id="${c.id}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
          </svg>
        </span>
      </span>`;

    btn.addEventListener('click', e => {
      const action = e.target.closest('[data-action]');
      if (action) {
        e.stopPropagation();
        if (action.dataset.action === 'delete') deleteChat(action.dataset.id);
        if (action.dataset.action === 'rename') openRenameModal(action.dataset.id);
        return;
      }
      openChat(c.id);
    });
    sbChats.appendChild(btn);
  });
}

async function openChat(id) {
  curId = id;
  curMessages = [];
  messages.innerHTML = '';
  welcome.style.display = 'none';
  renderHistory();

  const q    = query(collection(db, 'users', currentUser.uid, 'chats', id, 'messages'), orderBy('createdAt'));
  const snap = await getDocs(q);
  snap.docs.forEach(d => {
    const m = d.data();
    curMessages.push({ role: m.role, content: m.content });
    addBubble(m.role, m.content);
  });
  messages.scrollTop = messages.scrollHeight;
}

function newChat() {
  curId = null;
  curMessages = [];
  messages.innerHTML = '';
  messages.appendChild(welcome);
  welcome.style.display = '';
  renderHistory();
}

newChatBtn.addEventListener('click', newChat);

// ── Input ─────────────────────────────────────────────────
msgInput.addEventListener('input', () => {
  msgInput.style.height = '24px';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 180) + 'px';
  sendBtn.disabled = !msgInput.value.trim() || busy;
});
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
sendBtn.addEventListener('click', submit);

window.hint = function(text) {
  msgInput.value = text;
  msgInput.dispatchEvent(new Event('input'));
  submit();
};

// ── Submit ────────────────────────────────────────────────
async function submit() {
  const rawText = msgInput.value.trim();
  if (!rawText || busy) return;

  // Проверка дневного лимита
  const count = await getTodayCount();
  if (count >= DAY_LIMIT) {
    showLimitError();
    return;
  }

  welcome.style.display = 'none';

  // Собираем текст + содержимое URL если есть
  let contextText = rawText;
  const urls = rawText.match(URL_RE);
  if (urls) {
    const indicator = addStatusMsg('Читаю ссылку...');
    for (const url of urls) {
      const content = await fetchUrlContent(url);
      if (content) contextText += `\n\n[Содержимое страницы ${url}]:\n${content}`;
    }
    indicator.remove();
  }

  // Создаём чат если нет
  if (!curId) {
    const chatRef = await addDoc(collection(db, 'users', currentUser.uid, 'chats'), {
      title:     rawText.slice(0, 40),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    curId = chatRef.id;
    chats.unshift({ id: curId, title: rawText.slice(0, 40) });
    renderHistory();
  }

  curMessages.push({ role: 'user', content: contextText });
  await addDoc(collection(db, 'users', currentUser.uid, 'chats', curId, 'messages'), {
    role: 'user', content: rawText, createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, 'users', currentUser.uid, 'chats', curId), { updatedAt: serverTimestamp() });

  addBubble('user', rawText);
  msgInput.value = '';
  msgInput.style.height = 'auto';
  sendBtn.disabled = true;
  busy = true;

  const aiEl   = addBubble('ai', '');
  const textEl = aiEl.querySelector('.msg__text');
  textEl.classList.add('typing');
  let full = '';

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'system', content: getSystemPrompt() }, ...curMessages],
        stream: true, max_tokens: 4096, temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error?.message || 'HTTP ' + res.status);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;
        if (!raw) continue;
        try {
          const delta = JSON.parse(raw).choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            textEl.innerHTML = marked.parse(full);
            textEl.classList.add('typing');
            textEl.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
            messages.scrollTop = messages.scrollHeight;
          }
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    textEl.innerHTML = `<span style="color:#f87171">Ошибка: ${err.message}</span>`;
    full = err.message;
  }

  textEl.classList.remove('typing');
  if (full) {
    curMessages.push({ role: 'assistant', content: full });
    await addDoc(collection(db, 'users', currentUser.uid, 'chats', curId, 'messages'), {
      role: 'assistant', content: full, createdAt: serverTimestamp(),
    });
    await incTodayCount();
    await refreshLimitDisplay();
  }

  busy = false;
  sendBtn.disabled = !msgInput.value.trim();
  messages.scrollTop = messages.scrollHeight;
}

function showLimitError() {
  const div = document.createElement('div');
  div.className = 'limit-toast';
  div.textContent = 'Лимит 100 запросов в день исчерпан. Попробуй завтра.';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

function addStatusMsg(text) {
  const div = document.createElement('div');
  div.className = 'status-msg';
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

// ── Bubble ────────────────────────────────────────────────
function addBubble(role, content) {
  const isUser = role === 'user';
  const html   = isUser ? esc(content) : (content ? marked.parse(content) : '');
  const div    = document.createElement('div');
  div.className = `msg msg--${role}`;
  div.innerHTML = `
    <div class="msg__row">
      <div class="msg__avatar${isUser ? '' : ' msg__avatar--ai'}">${isUser
        ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.21 4.8-4.8S14.7 2.4 12 2.4 7.2 4.59 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.61-9.6 4.8v2.4h19.2v-2.4c0-3.19-6.4-4.8-9.6-4.8z"/></svg>`
        : `<img src="comet.svg" class="comet-logo" width="18" height="18" alt="" style="object-fit:contain"/>`
      }</div>
      <div class="msg__content">
        <div class="msg__name">${isUser ? 'Вы' : 'Cometa'}</div>
        <div class="msg__text">${html}</div>
      </div>
    </div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ── Settings ──────────────────────────────────────────────
const settingsBtn     = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose   = document.getElementById('settingsClose');
const themeToggle     = document.getElementById('themeToggle');

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  localStorage.setItem('cometa_theme', theme);
  themeToggle.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

settingsBtn.addEventListener('click', async () => {
  document.getElementById('settingsUsername').textContent =
    localStorage.getItem('cometa_username') || '';
  settingsOverlay.classList.add('open');
  await refreshLimitDisplay();
});

// Prompt modal
const promptOverlay = document.getElementById('promptOverlay');
const promptInput   = document.getElementById('userPromptInput');
const promptSave    = document.getElementById('promptSave');
const promptCancel  = document.getElementById('promptCancel');
const promptClose   = document.getElementById('promptClose');

document.getElementById('openPromptBtn').addEventListener('click', () => {
  settingsOverlay.classList.remove('open');
  promptInput.value = localStorage.getItem('cometa_user_prompt') || '';
  promptOverlay.classList.add('open');
  setTimeout(() => promptInput.focus(), 80);
});
function closePromptModal() { promptOverlay.classList.remove('open'); }
promptClose.addEventListener('click', closePromptModal);
promptCancel.addEventListener('click', closePromptModal);
promptOverlay.addEventListener('click', e => { if (e.target === promptOverlay) closePromptModal(); });
promptSave.addEventListener('click', () => {
  localStorage.setItem('cometa_user_prompt', promptInput.value);
  closePromptModal();
});

settingsClose.addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });
themeToggle.addEventListener('click', e => {
  const btn = e.target.closest('.theme-opt');
  if (btn) applyTheme(btn.dataset.theme);
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  settingsOverlay.classList.remove('open');
  const ok = await showConfirm('Выйти из аккаунта?', 'Вы будете перенаправлены на страницу входа.', 'Выйти');
  if (!ok) return;
  await signOut(auth);
  localStorage.removeItem('cometa_username');
  window.location.href = 'auth.html';
});

document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
  settingsOverlay.classList.remove('open');
  const ok = await showConfirm('Удалить аккаунт?', 'Все чаты и данные будут удалены безвозвратно.');
  if (!ok) return;
  try {
    const uid = currentUser.uid;
    // Удаляем все чаты и сообщения
    const chatsSnap = await getDocs(collection(db, 'users', uid, 'chats'));
    for (const chatDoc of chatsSnap.docs) {
      const msgsSnap = await getDocs(collection(db, 'users', uid, 'chats', chatDoc.id, 'messages'));
      for (const m of msgsSnap.docs) await deleteDoc(m.ref);
      await deleteDoc(chatDoc.ref);
    }
    await deleteDoc(doc(db, 'users', uid));
    await deleteUser(currentUser);
    localStorage.removeItem('cometa_username');
    window.location.href = 'auth.html';
  } catch (err) {
    alert('Для удаления аккаунта выйди и войди заново, затем повтори попытку.');
  }
});
