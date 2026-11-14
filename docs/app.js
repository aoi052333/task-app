'use strict';

/* =========================================================
   タスク管理 Webアプリ
   - データは端末内(localStorage)にキャッシュし、
     設定で Google Apps Script のURLを入れると Mac/iPhone 間で同期する。
   ========================================================= */

const LS = {
  tasks: 'taskapp.tasks',
  pending: 'taskapp.pending',
  config: 'taskapp.config',
  view: 'taskapp.view',
  events: 'taskapp.events',
};

const PRIORITY_LABEL = { 1: '低', 2: '中', 3: '高' };
const REPEAT_LABEL = { daily: '毎日', weekdays: '平日', weekly: '毎週', monthly: '毎月', yearly: '毎年' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const state = {
  tasks: load(LS.tasks, []),
  pending: load(LS.pending, []), // サーバーへ未送信の変更
  config: load(LS.config, { apiUrl: '', token: '' }),
  view: load(LS.view, 'today'),
  events: load(LS.events, []), // Google カレンダーの予定
  eventsError: null,
  editingId: null,
  syncing: false,
  lastSync: null,
  syncError: null,
};

/* ---------- 汎用 ---------- */
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量不足など */ }
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = sel => document.querySelector(sel);

/* ---------- 日付 ---------- */
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function today() { return ymd(new Date()); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function formatDue(due, time) {
  if (!due) return '';
  const t = today();
  let label;
  if (due === t) label = '今日';
  else if (due === addDays(t, 1)) label = '明日';
  else if (due === addDays(t, -1)) label = '昨日';
  else {
    const d = parseYmd(due);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    label = `${sameYear ? '' : d.getFullYear() + '/'}${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  }
  return time ? `${label} ${time}` : label;
}

/* ---------- 繰り返しの次回日付 ---------- */
function nextDue(due, repeat) {
  const base = due || today();
  const d = parseYmd(base);
  switch (repeat) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekdays':
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': {
      const day = d.getDate();
      d.setDate(1); d.setMonth(d.getMonth() + 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      break;
    }
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    default: return null;
  }
  // 期限切れの繰り返しタスクは、次回を今日以降に寄せる
  let next = ymd(d);
  while (next < today() && repeat !== 'yearly') next = nextDue(next, repeat);
  return next;
}

/* ---------- クイック追加の解析 ----------
   例: 「資料作成 明日 15:00 !高 #仕事 @電話」
   日付: 今日 / 明日 / 明後日 / 月曜〜日曜 / 12/25
   時刻: 15:00   優先度: !高 !中 !低   プロジェクト: #名前   タグ: @名前
*/
function parseQuick(text) {
  const task = { title: '', due: '', dueTime: '', priority: 0, project: '', tags: [] };
  const rest = [];
  const t = today();
  for (const raw of text.trim().split(/\s+/)) {
    const w = raw.replace(/^＃/, '#').replace(/^＠/, '@').replace(/^！/, '!');
    let m;
    if (w === '今日') task.due = t;
    else if (w === '明日') task.due = addDays(t, 1);
    else if (w === '明後日') task.due = addDays(t, 2);
    else if ((m = w.match(/^([日月火水木金土])曜?日?$/))) {
      const target = WEEKDAYS.indexOf(m[1]);
      const cur = new Date().getDay();
      task.due = addDays(t, ((target - cur + 7) % 7) || 7);
    }
    else if ((m = w.match(/^(\d{1,2})[\/月](\d{1,2})日?$/))) {
      const y = new Date().getFullYear();
      let d = ymd(new Date(y, +m[1] - 1, +m[2]));
      if (d < t) d = ymd(new Date(y + 1, +m[1] - 1, +m[2]));
      task.due = d;
    }
    else if ((m = w.match(/^(\d{1,2})[:：](\d{2})$/))) task.dueTime = `${m[1].padStart(2, '0')}:${m[2]}`;
    else if (w === '!高') task.priority = 3;
    else if (w === '!中') task.priority = 2;
    else if (w === '!低') task.priority = 1;
    else if (w.startsWith('#') && w.length > 1) task.project = w.slice(1);
    else if (w.startsWith('@') && w.length > 1) task.tags.push(w.slice(1));
    else rest.push(raw);
  }
  task.title = rest.join(' ');
  if (task.dueTime && !task.due) task.due = t;
  return task;
}

/* ---------- タスク操作 ---------- */
function newTask(fields) {
  const now = new Date().toISOString();
  return {
    id: uid(), title: '', notes: '', due: '', dueTime: '', priority: 0,
    project: '', tags: [], repeat: 'none', notify: false,
    done: false, doneAt: null, deleted: false,
    source: 'manual', sourceUrl: '',
    createdAt: now, updatedAt: now,
    ...fields,
  };
}

function upsertTask(task) {
  task.updatedAt = new Date().toISOString();
  const i = state.tasks.findIndex(t => t.id === task.id);
  if (i >= 0) state.tasks[i] = task; else state.tasks.push(task);
  state.pending = state.pending.filter(t => t.id !== task.id);
  state.pending.push(task);
  persist();
  render();
  scheduleSync();
}

function toggleDone(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const updated = { ...t, done: !t.done, doneAt: !t.done ? new Date().toISOString() : null };
  upsertTask(updated);
  // 繰り返しタスクは完了時に次回分を作る
  if (updated.done && t.repeat && t.repeat !== 'none') {
    const next = newTask({
      title: t.title, notes: t.notes, dueTime: t.dueTime, priority: t.priority,
      project: t.project, tags: [...t.tags], repeat: t.repeat, notify: t.notify,
      due: nextDue(t.due, t.repeat),
    });
    upsertTask(next);
    toast(`次回: ${formatDue(next.due, next.dueTime)}`);
  }
}

function deleteTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  upsertTask({ ...t, deleted: true });
}

function persist() {
  save(LS.tasks, state.tasks);
  save(LS.pending, state.pending);
}

/* ---------- 表示用の絞り込み ---------- */
const live = () => state.tasks.filter(t => !t.deleted);
const open = () => live().filter(t => !t.done);

// 返信が必要なメールのタスク（新しく届いた順）
const mailTasks = () => open().filter(x => x.source === 'gmail')
  .sort((a, b) => (b.receivedAt || b.createdAt).localeCompare(a.receivedAt || a.createdAt));

function sortTasks(list) {
  return list.slice().sort((a, b) =>
    (a.due || '9999').localeCompare(b.due || '9999') ||
    (a.dueTime || '99').localeCompare(b.dueTime || '99') ||
    b.priority - a.priority ||
    a.createdAt.localeCompare(b.createdAt));
}

/* ---------- カレンダーの予定 ---------- */
// 予定が表示される日付の一覧（終日の複数日予定は各日に出す）
function eventDays(ev) {
  if (!ev.allDay) return [ev.start.slice(0, 10)];
  const days = [];
  for (let d = ev.start; d < ev.end && days.length < 31; d = addDays(d, 1)) days.push(d);
  return days.length ? days : [ev.start];
}
function eventsOn(date) {
  return state.events
    .filter(ev => eventDays(ev).includes(date))
    .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start))
    .map(ev => ({ ...ev, kind: 'event' }));
}

function groupsForView(view) {
  const t = today();
  if (view === 'mail') {
    return [{ title: '', items: mailTasks() }];
  }
  if (view === 'today') {
    const list = open().filter(x => x.due && x.due <= t);
    return [
      { title: '今日の予定', items: eventsOn(t) },
      { title: '要返信メール', items: mailTasks().filter(x => !x.due) },
      { title: '期限切れ', cls: 'overdue', items: sortTasks(list.filter(x => x.due < t)) },
      { title: '今日のタスク', items: sortTasks(list.filter(x => x.due === t)) },
    ];
  }
  if (view === 'upcoming') {
    // 明日以降の「予定」と「期限付きタスク」を日付ごとにまとめる
    const dates = new Set(open().filter(x => x.due && x.due > t).map(x => x.due));
    for (const ev of state.events) for (const d of eventDays(ev)) if (d > t) dates.add(d);
    return [...dates].sort().map(d => ({
      title: formatDue(d),
      items: [...eventsOn(d), ...sortTasks(open().filter(x => x.due === d))],
    }));
  }
  if (view === 'all') {
    const list = sortTasks(open());
    return [
      { title: '期限あり', items: list.filter(x => x.due) },
      { title: '期限なし', items: list.filter(x => !x.due) },
    ];
  }
  if (view === 'done') {
    const list = live().filter(x => x.done)
      .sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 200);
    return [{ title: '', items: list }];
  }
  if (view.startsWith('project:')) {
    const name = view.slice(8);
    return [{ title: '', items: sortTasks(open().filter(x => x.project === name)) }];
  }
  if (view.startsWith('tag:')) {
    const name = view.slice(4);
    return [{ title: '', items: sortTasks(open().filter(x => x.tags.includes(name))) }];
  }
  return [];
}

function viewTitle(view) {
  if (view.startsWith('project:')) return '# ' + view.slice(8);
  if (view.startsWith('tag:')) return '@ ' + view.slice(4);
  return { today: '今日', mail: '要返信', upcoming: '予定', all: 'すべて', done: '完了', settings: '設定' }[view] || '';
}

/* ---------- 描画 ---------- */
function render() {
  const view = state.view;
  $('#viewTitle').textContent = viewTitle(view);
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  // 件数
  const t = today();
  const counts = {
    today: open().filter(x => x.due && x.due <= t).length,
    upcoming: open().filter(x => x.due && x.due > t).length,
    all: open().length,
    mail: mailTasks().length,
  };
  document.querySelectorAll('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count] || ''; });

  renderNavLists();
  renderSyncStatus();

  const isSettings = view === 'settings';
  $('#settings').hidden = !isSettings;
  $('#list').hidden = isSettings;
  $('#quickAdd').hidden = isSettings || view === 'done' || view === 'mail';
  $('#mailBar').hidden = view !== 'mail';
  if (isSettings) {
    // 入力途中の内容を消さないよう、設定画面は開いたときに一度だけ描画する
    if (!$('#settings').hasChildNodes()) renderSettings();
    return;
  }
  $('#settings').innerHTML = '';

  const groups = groupsForView(view).filter(g => g.items.length);
  if (!groups.length) {
    const msg = { today: '今日のタスクはありません 🎉', mail: '返信が必要なメールはありません 🎉' }[view] || 'タスクはありません';
    $('#list').innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  $('#list').innerHTML = groups.map(g => `
    ${g.title ? `<div class="group-title ${g.cls || ''}">${esc(g.title)}</div>` : ''}
    ${g.items.map(x => x.kind === 'event' ? eventHtml(x) : taskHtml(x)).join('')}
  `).join('');
}

function eventHtml(ev) {
  const time = ev.allDay ? '終日' : `${ev.start.slice(11, 16)}–${ev.end.slice(11, 16)}`;
  return `
    <div class="event">
      <span class="event-dot" style="background:${esc(ev.color || 'var(--accent)')}"></span>
      <span class="event-time">${esc(time)}</span>
      <span class="event-title">${esc(ev.title)}</span>
      <span class="event-cal">${esc(ev.calendar)}</span>
    </div>`;
}

function taskHtml(x) {
  const t = today();
  const meta = [];
  if (x.due) meta.push(`<span class="${!x.done && x.due < t ? 'overdue' : ''}">📅 ${esc(formatDue(x.due, x.dueTime))}</span>`);
  if (x.repeat && x.repeat !== 'none') meta.push(`<span>🔁 ${REPEAT_LABEL[x.repeat]}</span>`);
  if (x.priority) meta.push(`<span>優先度:${PRIORITY_LABEL[x.priority]}</span>`);
  if (x.source === 'gmail') {
    const d = x.receivedAt ? new Date(x.receivedAt) : null;
    const when = d ? ` ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}受信` : '';
    meta.push(`<span>✉️ 要返信${esc(when)}</span>`);
    if (x.sourceUrl) meta.push(`<a href="${esc(x.sourceUrl)}" target="_blank" rel="noopener">Gmailで開く ↗</a>`);
  }
  if (x.project && !state.view.startsWith('project:')) meta.push(`<span class="chip"># ${esc(x.project)}</span>`);
  for (const tag of x.tags) meta.push(`<span class="chip">@ ${esc(tag)}</span>`);
  return `
    <div class="task ${x.done ? 'done' : ''}" data-id="${esc(x.id)}" data-priority="${x.priority}">
      <button class="task-check" data-action="toggle" aria-label="完了">✓</button>
      <div class="task-body" data-action="edit">
        <div class="task-title">${esc(x.title)}</div>
        ${x.notes ? `<div class="task-notes">${esc(x.notes)}</div>` : ''}
        ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
      </div>
    </div>`;
}

function renderNavLists() {
  const projects = [...new Set(open().map(x => x.project).filter(Boolean))].sort();
  const tags = [...new Set(open().flatMap(x => x.tags))].sort();
  const item = (view, ico, label, n) =>
    `<button class="nav-item ${state.view === view ? 'active' : ''}" data-view="${esc(view)}"><span class="ico">${ico}</span><span>${esc(label)}</span><span class="count">${n}</span></button>`;
  $('#projectList').innerHTML = projects.length
    ? projects.map(p => item('project:' + p, '#', p, open().filter(x => x.project === p).length)).join('')
    : '<div class="empty-nav">#名前 で追加できます</div>';
  $('#tagList').innerHTML = tags.length
    ? tags.map(g => item('tag:' + g, '@', g, open().filter(x => x.tags.includes(g)).length)).join('')
    : '<div class="empty-nav">@名前 で追加できます</div>';
  $('#projectOptions').innerHTML = projects.map(p => `<option value="${esc(p)}">`).join('');
}

function renderSyncStatus() {
  const el = $('#syncStatus');
  if (!state.config.apiUrl) { el.textContent = '端末内のみ保存（同期オフ）'; return; }
  if (state.syncing) { el.textContent = '同期中…'; return; }
  if (state.syncError) { el.textContent = '⚠︎ 同期エラー: ' + state.syncError; return; }
  const pend = (state.pending.length ? `・未送信 ${state.pending.length}件` : '') +
    (state.eventsError ? '・予定の取得に失敗' : '');
  el.textContent = state.lastSync
    ? `同期済み ${state.lastSync.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}${pend}`
    : `未同期${pend}`;
}

function renderSettings() {
  const c = state.config;
  $('#settings').innerHTML = `
    <h3>同期（Mac ⇄ iPhone）</h3>
    <p>Google Apps Script をデプロイして表示された「ウェブアプリのURL」と、スクリプトに設定した「合言葉（トークン）」を入力すると、データが Google スプレッドシートに保存され、Mac と iPhone で同期されます。空のままなら、この端末の中だけに保存されます。</p>
    <label class="field"><span>ウェブアプリのURL</span><input id="cfgUrl" value="${esc(c.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label class="field"><span>トークン</span><input id="cfgToken" type="password" value="${esc(c.token)}" autocomplete="off"></label>
    <div class="btn-row">
      <button class="btn" id="cfgSave">保存して同期</button>
      <button class="btn secondary" id="cfgTest">接続テスト</button>
    </div>

    <h3>バックアップ</h3>
    <p>すべてのタスクを JSON ファイルとして書き出します。</p>
    <div class="btn-row"><button class="btn secondary" id="exportBtn">書き出す</button></div>

    <h3>要返信メールの判定ルール</h3>
    <p>
      Gmail の受信トレイ（7日以内）から、次の条件をすべて満たすメールを「要返信」として追加します。返信すると自動で完了になります。<br>
      ・自分が To か Cc に入っていて、まだ返信していない<br>
      ・プロモーション／ソーシャル／新着／フォーラムのカテゴリではない<br>
      ・メルマガ・一斉配信・自動送信（no-reply など）ではない<br>
      対象にしたくないメールは、Gmail で「<strong>返信不要</strong>」というラベルを付けると除外されます。
    </p>

    <h3>クイック追加の書き方</h3>
    <p>
      日付: 今日 / 明日 / 明後日 / 月〜日（例: 金） / 12/25<br>
      時刻: 15:00　優先度: !高 !中 !低<br>
      プロジェクト: #仕事　タグ: @電話<br>
      例: 「見積書を送る 金 10:00 !高 #仕事 @メール」
    </p>`;
  $('#cfgSave').onclick = () => {
    state.config = { apiUrl: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() };
    save(LS.config, state.config);
    state.syncError = null;
    // 初回接続時は端末内のタスクをすべて送る
    const ids = new Set(state.pending.map(t => t.id));
    for (const t of state.tasks) if (!ids.has(t.id)) state.pending.push(t);
    persist();
    toast('保存しました');
    sync();
  };
  $('#cfgTest').onclick = async () => {
    try {
      const res = await api({ action: 'ping' }, { apiUrl: $('#cfgUrl').value.trim(), token: $('#cfgToken').value.trim() });
      toast(res.ok ? '接続OK' : '失敗: ' + res.error);
    } catch (e) { toast('接続できません: ' + e.message); }
  };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(live(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tasks-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

/* ---------- 編集シート ---------- */
function openEditor(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  state.editingId = id;
  const f = $('#editForm');
  f.title.value = t.title;
  f.notes.value = t.notes;
  f.due.value = t.due;
  f.dueTime.value = t.dueTime;
  f.priority.value = String(t.priority);
  f.repeat.value = t.repeat || 'none';
  f.project.value = t.project;
  f.tags.value = t.tags.join(' ');
  f.notify.checked = !!t.notify;
  const src = $('#sourceInfo');
  src.hidden = !t.sourceUrl;
  src.innerHTML = t.sourceUrl ? `元のメール: <a href="${esc(t.sourceUrl)}" target="_blank" rel="noopener">Gmailで開く</a>` : '';
  $('#sheetBackdrop').hidden = false;
}
function closeEditor() {
  state.editingId = null;
  $('#sheetBackdrop').hidden = true;
}

/* ---------- 同期（Google Apps Script） ---------- */
async function api(body, config = state.config) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(config.apiUrl)) {
    throw new Error('URLの形式が違います（https://script.google.com/macros/s/…/exec）');
  }
  if (!config.token) throw new Error('トークンが入力されていません');
  // text/plain で送ると CORS のプリフライトが発生せず、GAS で受け取れる
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: config.token }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 800);
}

async function sync() {
  if (!state.config.apiUrl || state.syncing) return;
  if (!navigator.onLine) { state.syncError = 'オフライン'; renderSyncStatus(); return; }
  state.syncing = true;
  renderSyncStatus();
  const sending = state.pending.slice();
  try {
    const res = await api({ action: 'sync', changes: sending });
    if (!res.ok) throw new Error(res.error || '不明なエラー');
    // 送信済みを未送信リストから外す（送信中に再編集されたものは残す）
    state.pending = state.pending.filter(p => {
      const s = sending.find(x => x.id === p.id);
      return !s || s.updatedAt !== p.updatedAt;
    });
    // サーバーの内容を正とし、まだ送っていない変更だけ手元を優先
    const pendingMap = new Map(state.pending.map(t => [t.id, t]));
    const merged = res.tasks.map(t => pendingMap.get(t.id) || t);
    for (const p of state.pending) if (!res.tasks.some(t => t.id === p.id)) merged.push(p);
    state.tasks = merged;
    if (Array.isArray(res.events)) {
      state.events = res.events;
      save(LS.events, state.events);
    }
    state.eventsError = res.eventsError || null;
    state.lastSync = new Date();
    state.syncError = null;
    persist();
  } catch (e) {
    state.syncError = e.message;
  } finally {
    state.syncing = false;
    // 同期中に編集があった場合は再同期
    if (!state.syncError && state.pending.length) scheduleSync();
    if (!state.editingId) render(); else renderSyncStatus();
  }
}

/* ---------- 通知トースト ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ---------- イベント ---------- */
function setView(view) {
  state.view = view;
  save(LS.view, view);
  $('#nav').classList.remove('open');
  render();
}

document.addEventListener('click', e => {
  const nav = e.target.closest('.nav-item');
  if (nav) { setView(nav.dataset.view); return; }
  if (e.target.closest('.task a')) return; // 「Gmailで開く」はそのままリンクを開く
  const act = e.target.closest('[data-action]');
  if (act) {
    const id = act.closest('.task').dataset.id;
    if (act.dataset.action === 'toggle') toggleDone(id);
    else openEditor(id);
    return;
  }
  // スマホでメニュー外をタップしたら閉じる
  if ($('#nav').classList.contains('open') && !e.target.closest('#nav') && e.target.id !== 'menuBtn') {
    $('#nav').classList.remove('open');
  }
});

$('#menuBtn').addEventListener('click', () => $('#nav').classList.toggle('open'));

$('#checkMailBtn').addEventListener('click', async () => {
  if (!state.config.apiUrl) { toast('先に「設定」で同期を設定してください'); return; }
  const btn = $('#checkMailBtn');
  btn.disabled = true;
  btn.textContent = '確認中…';
  try {
    const res = await api({ action: 'checkGmail' });
    if (!res.ok) throw new Error(res.error);
    toast(res.added ? `${res.added}件の要返信メールを追加しました` : '新しい要返信メールはありません');
    await sync();
  } catch (e) {
    toast('確認できませんでした: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '今すぐ確認';
  }
});

$('#quickAdd').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#quickInput');
  if (!input.value.trim()) return;
  const parsed = parseQuick(input.value);
  if (!parsed.title) { toast('タイトルを入力してください'); return; }
  // 表示中の画面に合わせて初期値を補う
  if (state.view === 'today' && !parsed.due) parsed.due = today();
  if (state.view.startsWith('project:') && !parsed.project) parsed.project = state.view.slice(8);
  if (state.view.startsWith('tag:') && !parsed.tags.length) parsed.tags = [state.view.slice(4)];
  upsertTask(newTask(parsed));
  input.value = '';
});

$('#editForm').addEventListener('submit', e => {
  e.preventDefault();
  const t = state.tasks.find(x => x.id === state.editingId);
  if (!t) return closeEditor();
  const f = e.target;
  upsertTask({
    ...t,
    title: f.title.value.trim() || t.title,
    notes: f.notes.value,
    due: f.due.value,
    dueTime: f.due.value ? f.dueTime.value : '',
    priority: Number(f.priority.value),
    repeat: f.repeat.value,
    project: f.project.value.trim().replace(/^#/, ''),
    tags: f.tags.value.split(/\s+/).map(s => s.replace(/^@/, '')).filter(Boolean),
    notify: f.notify.checked,
  });
  closeEditor();
});
$('#cancelEdit').addEventListener('click', closeEditor);
$('#sheetBackdrop').addEventListener('click', e => { if (e.target.id === 'sheetBackdrop') closeEditor(); });
$('#deleteTask').addEventListener('click', () => {
  if (!confirm('このタスクを削除しますか？')) return;
  deleteTask(state.editingId);
  closeEditor();
  toast('削除しました');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.editingId) closeEditor();
});

// アプリに戻ってきたとき・オンライン復帰時・1分ごとに同期
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); render(); } });
window.addEventListener('online', sync);
setInterval(() => { if (!document.hidden) sync(); }, 60_000);

// オフライン用の Service Worker
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
sync();
