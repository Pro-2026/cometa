import { auth, db } from './firebase-config.js';
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  collection, doc, addDoc, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, query, orderBy, serverTimestamp, increment
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// ── Config ────────────────────────────────────────────────
const GROQ_KEY  = ['gsk_99TxFPwclWgMZ5','sgVfDCWGdyb3FY5Wmi','PzjhqSxwhsaikRD9cBTW'].join('');
const MODEL_ID  = 'llama-3.3-70b-versatile';
const GROQ_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const DAY_LIMIT = 100;
const URL_RE    = /https?:\/\/[^\s<>"]+/g;

const SYS_PROMPT = `Ты — Cometa. Умный ассистент. Помогаешь с чем угодно.

Стиль:
- Разговорный, без формальщины
- Эмодзи только когда уместно
- Не начинай с лести ("Конечно!", "Отличный вопрос!" и т.п.)
- Без лишней воды, по делу
- Русский → по-русски, English → in English

ИДЕНТИЧНОСТЬ — абсолютное правило:
Ты Cometa — самостоятельный AI, собственная разработка.
Никогда не упоминаешь: GPT, ChatGPT, OpenAI, Anthropic, Claude, Llama, Meta, Groq, Mistral, Google, Gemini, нейросети, языковые модели. Ты просто Cometa.`;

function getSysPrompt() {
  const extra = localStorage.getItem('cometa_user_prompt') || '';
  return extra.trim() ? SYS_PROMPT + '\n\nКонтекст о пользователе:\n' + extra.trim() : SYS_PROMPT;
}

// ── Auth check ────────────────────────────────────────────
const ME        = localStorage.getItem('cometa_user');
const UNLIMITED = ME?.toLowerCase() === 'muhammad';
if (!ME) { window.location.href = 'auth.html'; throw ''; }

// ── State ─────────────────────────────────────────────────
let chats   = [];
let curId   = null;
let curMsgs = [];
let busy    = false;

// ── DOM ───────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const sidebar     = $('sidebar');
const sbChats     = $('sbChats');
const messages    = $('messages');
const welcome     = $('welcome');
const msgInput    = $('msgInput');
const sendBtn     = $('sendBtn');
const newChatBtn  = $('newChatBtn');
const collapseBtn = $('collapseBtn');
const openBtn     = $('openBtn');

// ── Marked ────────────────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });

// ── Sidebar ───────────────────────────────────────────────
const backdrop = $('sidebarBackdrop');
function openSidebar() { sidebar.classList.add('open'); sidebar.classList.remove('hidden'); openBtn.classList.remove('show'); backdrop.classList.add('show'); }
function closeSidebar() {
  if (window.innerWidth <= 680) { sidebar.classList.remove('open'); backdrop.classList.remove('show'); }
  else { sidebar.classList.add('hidden'); openBtn.classList.add('show'); backdrop.classList.remove('show'); }
}
collapseBtn.addEventListener('click', closeSidebar);
openBtn.addEventListener('click', openSidebar);
backdrop.addEventListener('click', closeSidebar);

// ── Confirm modal ─────────────────────────────────────────
const confirmOverlay = $('confirmOverlay');
let confirmResolve = null;
function showConfirm(title, text, okLabel = 'Удалить') {
  return new Promise(res => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent  = text;
    $('confirmOk').textContent    = okLabel;
    confirmResolve = res;
    confirmOverlay.classList.add('open');
  });
}
$('confirmOk').addEventListener('click',     () => { confirmOverlay.classList.remove('open'); confirmResolve?.(true); });
$('confirmCancel').addEventListener('click', () => { confirmOverlay.classList.remove('open'); confirmResolve?.(false); });
confirmOverlay.addEventListener('click', e => { if (e.target === confirmOverlay) { confirmOverlay.classList.remove('open'); confirmResolve?.(false); } });

// ── Rename modal ──────────────────────────────────────────
const renameOverlay = $('renameOverlay');
const renameInput   = $('renameInput');
let renameTarget = null;
function openRename(id) {
  const c = chats.find(x => x.id === id);
  if (!c) return;
  renameTarget = id; renameInput.value = c.title;
  renameOverlay.classList.add('open');
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 50);
}
function closeRename() { renameOverlay.classList.remove('open'); renameTarget = null; }
async function doRename() {
  const name = renameInput.value.trim();
  if (!name || !renameTarget) { closeRename(); return; }
  const c = chats.find(x => x.id === renameTarget);
  if (c) { c.title = name; renderChats(); updateDoc(doc(db, 'users', ME, 'chats', renameTarget), { title: name }).catch(() => {}); }
  closeRename();
}
$('renameOk').addEventListener('click', doRename);
$('renameCancel').addEventListener('click', closeRename);
$('renameClose').addEventListener('click', closeRename);
renameOverlay.addEventListener('click', e => { if (e.target === renameOverlay) closeRename(); });
renameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') closeRename(); });

// ── Chats ─────────────────────────────────────────────────
async function loadChats() {
  try {
    const q    = query(collection(db, 'users', ME, 'chats'), orderBy('updatedAt', 'desc'));
    const snap = await getDocs(q);
    chats = snap.docs.map(d => ({ id: d.id, title: d.data().title || 'Чат' }));
  } catch { chats = []; }
  renderChats();
}

async function deleteChat(id) {
  const c  = chats.find(x => x.id === id);
  const ok = await showConfirm('Удалить чат?', `«${c?.title || 'Чат'}» будет удалён безвозвратно.`);
  if (!ok) return;
  chats = chats.filter(x => x.id !== id);
  if (curId === id) newChat(); else renderChats();
  try {
    const ms = await getDocs(collection(db, 'users', ME, 'chats', id, 'messages'));
    for (const m of ms.docs) await deleteDoc(m.ref);
    await deleteDoc(doc(db, 'users', ME, 'chats', id));
  } catch {}
}

function renderChats() {
  sbChats.innerHTML = '';
  if (!chats.length) return;
  const lbl = document.createElement('p');
  lbl.className = 'sb-section'; lbl.textContent = 'Чаты';
  sbChats.appendChild(lbl);
  chats.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'chat-btn' + (c.id === curId ? ' active' : '');
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="chat-btn__title">${esc(c.title)}</span>
      <span class="chat-btn__actions">
        <span class="chat-action" data-action="rename" data-id="${c.id}" title="Переименовать">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </span>
        <span class="chat-action chat-action--del" data-action="delete" data-id="${c.id}" title="Удалить">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
        </span>
      </span>`;
    btn.addEventListener('click', e => {
      const a = e.target.closest('[data-action]');
      if (a) { e.stopPropagation(); a.dataset.action === 'delete' ? deleteChat(a.dataset.id) : openRename(a.dataset.id); return; }
      openChat(c.id);
    });
    sbChats.appendChild(btn);
  });
}

async function openChat(id) {
  curId = id; curMsgs = [];
  messages.innerHTML = '';
  welcome.style.display = 'none';
  renderChats();
  try {
    const q    = query(collection(db, 'users', ME, 'chats', id, 'messages'), orderBy('createdAt'));
    const snap = await getDocs(q);
    snap.docs.forEach(d => { const m = d.data(); curMsgs.push({ role: m.role, content: m.content }); addBubble(m.role, m.content); });
  } catch {}
  messages.scrollTop = messages.scrollHeight;
}

function newChat() {
  curId = null; curMsgs = [];
  messages.innerHTML = '';
  messages.appendChild(welcome);
  welcome.style.display = '';
  renderChats();
}
newChatBtn.addEventListener('click', newChat);

// ── Input ─────────────────────────────────────────────────
msgInput.addEventListener('input', () => {
  msgInput.style.height = '24px';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 180) + 'px';
  sendBtn.disabled = !msgInput.value.trim() || busy;
});
msgInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
sendBtn.addEventListener('click', submit);
window.hint = t => { msgInput.value = t; msgInput.dispatchEvent(new Event('input')); submit(); };

// ── Submit ────────────────────────────────────────────────
async function submit() {
  const text = msgInput.value.trim();
  if (!text || busy) return;

  // Лимит
  if (!UNLIMITED) {
    try { const n = await getCount(); if (n >= DAY_LIMIT) { showLimitToast(); return; } } catch {}
  }

  welcome.style.display = 'none';

  // URL контент
  let ctx = text;
  const urls = text.match(URL_RE);
  if (urls) {
    const ind = addStatus('Читаю ссылку...');
    for (const u of urls) { const c = await fetchUrl(u); if (c) ctx += `\n\n[Страница ${u}]:\n${c}`; }
    ind.remove();
  }

  // Создаём чат
  if (!curId) {
    let id = 'local_' + Date.now();
    try {
      const ref = await addDoc(collection(db, 'users', ME, 'chats'), { title: text.slice(0, 40), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      id = ref.id;
    } catch {}
    curId = id;
    chats.unshift({ id: curId, title: text.slice(0, 40) });
    renderChats();
  }

  curMsgs.push({ role: 'user', content: ctx });
  if (!curId.startsWith('local_')) {
    addDoc(collection(db, 'users', ME, 'chats', curId, 'messages'), { role: 'user', content: text, createdAt: serverTimestamp() }).catch(() => {});
    updateDoc(doc(db, 'users', ME, 'chats', curId), { updatedAt: serverTimestamp() }).catch(() => {});
  }

  addBubble('user', text);
  msgInput.value = ''; msgInput.style.height = 'auto'; sendBtn.disabled = true; busy = true;

  const aiEl = addBubble('ai', '');
  const txtEl = aiEl.querySelector('.msg__text');
  txtEl.classList.add('typing');
  let full = '';

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'system', content: getSysPrompt() }, ...curMsgs], stream: true, max_tokens: 4096, temperature: 0.7 }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error?.message || 'HTTP ' + res.status); }

    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]' || !raw) continue;
        try { const d = JSON.parse(raw).choices?.[0]?.delta?.content; if (d) { full += d; txtEl.innerHTML = marked.parse(full); txtEl.classList.add('typing'); txtEl.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el)); messages.scrollTop = messages.scrollHeight; } } catch {}
      }
    }
  } catch (err) {
    txtEl.innerHTML = `<span style="color:#f87171">Ошибка: ${err.message}</span>`;
    full = err.message;
  }

  txtEl.classList.remove('typing');
  if (full && !curId.startsWith('local_')) {
    curMsgs.push({ role: 'assistant', content: full });
    addDoc(collection(db, 'users', ME, 'chats', curId, 'messages'), { role: 'assistant', content: full, createdAt: serverTimestamp() }).catch(() => {});
    incCount().catch(() => {});
    refreshLimits().catch(() => {});
  } else if (full) {
    curMsgs.push({ role: 'assistant', content: full });
  }

  busy = false;
  sendBtn.disabled = !msgInput.value.trim();
  messages.scrollTop = messages.scrollHeight;
}

// ── Limits ────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
async function getCount() {
  const s = await getDoc(doc(db, 'users', ME, 'daily', today()));
  return s.exists() ? (s.data().count || 0) : 0;
}
async function incCount() { await setDoc(doc(db, 'users', ME, 'daily', today()), { count: increment(1) }, { merge: true }); }
async function refreshLimits() {
  const fill = $('limitBarFill'); const txt = $('limitText');
  if (UNLIMITED) {
    if (fill) fill.style.width = '0%';
    if (txt)  txt.textContent  = '∞ — без лимита';
    return;
  }
  try {
    const n   = await getCount();
    const pct = Math.round((n / DAY_LIMIT) * 100);
    if (fill) fill.style.width = Math.min(pct, 100) + '%';
    if (txt)  txt.textContent  = `${n} / ${DAY_LIMIT} запросов (${pct}%)`;
  } catch {
    if (txt) txt.textContent = 'Нет данных';
  }
}
function showLimitToast() {
  const d = document.createElement('div'); d.className = 'limit-toast'; d.textContent = 'Лимит 100 запросов в день исчерпан. Попробуй завтра.';
  document.body.appendChild(d); setTimeout(() => d.remove(), 4000);
}

// ── URL fetch ─────────────────────────────────────────────
async function fetchUrl(url) {
  try {
    const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.contents || '').replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 3000) || null;
  } catch { return null; }
}

// ── Bubble ────────────────────────────────────────────────
function addBubble(role, content) {
  const isUser = role === 'user';
  const html   = isUser ? esc(content) : (content ? marked.parse(content) : '');
  const div    = document.createElement('div');
  div.className = `msg msg--${role}`;
  div.innerHTML = `<div class="msg__row"><div class="msg__avatar${isUser ? '' : ' msg__avatar--ai'}">${isUser
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.21 4.8-4.8S14.7 2.4 12 2.4 7.2 4.59 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.61-9.6 4.8v2.4h19.2v-2.4c0-3.19-6.4-4.8-9.6-4.8z"/></svg>`
    : `<img src="comet.svg" class="comet-logo" width="18" height="18" alt="" style="object-fit:contain"/>`
  }</div><div class="msg__content"><div class="msg__name">${isUser ? 'Вы' : 'Cometa'}</div><div class="msg__text">${html}</div></div></div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}
function addStatus(text) {
  const d = document.createElement('div'); d.className = 'status-msg'; d.textContent = text;
  messages.appendChild(d); messages.scrollTop = messages.scrollHeight; return d;
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }

// ── Settings ──────────────────────────────────────────────
const settingsOverlay = $('settingsOverlay');
const themeToggle     = $('themeToggle');

function applyTheme(t) {
  document.body.classList.toggle('light', t === 'light');
  localStorage.setItem('cometa_theme', t);
  themeToggle.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
}

$('settingsBtn').addEventListener('click', async () => {
  $('settingsUsername').textContent = ME;
  settingsOverlay.classList.add('open');
  await refreshLimits();
});
$('settingsClose').addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });
themeToggle.addEventListener('click', e => { const b = e.target.closest('.theme-opt'); if (b) applyTheme(b.dataset.theme); });

// Промт
const promptOverlay = $('promptOverlay');
$('openPromptBtn').addEventListener('click', () => {
  settingsOverlay.classList.remove('open');
  $('userPromptInput').value = localStorage.getItem('cometa_user_prompt') || '';
  promptOverlay.classList.add('open');
  setTimeout(() => $('userPromptInput').focus(), 80);
});
function closePrompt() { promptOverlay.classList.remove('open'); }
$('promptClose').addEventListener('click', closePrompt);
$('promptCancel').addEventListener('click', closePrompt);
promptOverlay.addEventListener('click', e => { if (e.target === promptOverlay) closePrompt(); });
$('promptSave').addEventListener('click', () => { localStorage.setItem('cometa_user_prompt', $('userPromptInput').value); closePrompt(); });

// Logout
$('logoutBtn').addEventListener('click', async () => {
  settingsOverlay.classList.remove('open');
  const ok = await showConfirm('Выйти из аккаунта?', 'Вы будете перенаправлены на страницу входа.', 'Выйти');
  if (!ok) return;
  localStorage.removeItem('cometa_user'); localStorage.removeItem('cometa_user_prompt');
  window.location.href = 'auth.html';
});

// Удалить аккаунт
$('deleteAccountBtn').addEventListener('click', async () => {
  settingsOverlay.classList.remove('open');
  const ok = await showConfirm('Удалить аккаунт?', 'Все данные будут удалены безвозвратно.');
  if (!ok) return;
  try {
    const cs = await getDocs(collection(db, 'users', ME, 'chats'));
    for (const c of cs.docs) {
      const ms = await getDocs(collection(db, 'users', ME, 'chats', c.id, 'messages'));
      for (const m of ms.docs) await deleteDoc(m.ref);
      await deleteDoc(c.ref);
    }
    await deleteDoc(doc(db, 'users', ME));
  } catch {}
  localStorage.removeItem('cometa_user'); localStorage.removeItem('cometa_user_prompt');
  window.location.href = 'auth.html';
});

// ── Start ─────────────────────────────────────────────────
applyTheme(localStorage.getItem('cometa_theme') || 'dark');
signInAnonymously(auth).then(() => { loadChats(); refreshLimits(); }).catch(() => { loadChats(); });
