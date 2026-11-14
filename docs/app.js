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
  filters: 'taskapp.filters',
};

const PRIORITY_LABEL = { 1: '低', 2: '中', 3: '高' };
const REPEAT_LABEL = { daily: '毎日', weekdays: '平日', weekly: '毎週', monthly: '毎月', yearly: '毎年' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const FILTERS = [
  { id: 'high', label: '優先度 高', test: t => t.priority === 3 },
  { id: 'mid', label: '中以上', test: t => t.priority >= 2 },
  { id: 'overdue', label: '期限切れ', test: t => t.due && t.due < today() },
  { id: 'nodue', label: '期限なし', test: t => !t.due },
  { id: 'repeat', label: '繰り返し', test: t => t.repeat && t.repeat !== 'none' },
];

const state = {
  tasks: load(LS.tasks, []),
  pending: load(LS.pending, []), // サーバーへ未送信の変更
  config: load(LS.config, { apiUrl: '', token: '' }),
  view: load(LS.view, 'today'),
  events: load(LS.events, []), // Google カレンダーの予定
  filters: load(LS.filters, []),
  eventsError: null,
  query: '',
  calMonth: '',     // カレンダーで表示中の月 (YYYY-MM)
  calSelected: '',  // カレンダーで選択中の日 (YYYY-MM-DD)
  editingId: null,  // 編集中のタスクID（新規作成時は 'new'）
  newDefaults: {},
  syncing: false,
  lastSync: null,
  syncError: null,
};

/* ---------- アイコン ---------- */
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3.5 7.5 8.5 6 8.5-6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="3"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
};
function icon(name) {
  return `<span data-icon="${name}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg></span>`;
}
function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]:empty').forEach(el => {
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[el.dataset.icon] || ''}</svg>`;
  });
}

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
// プロジェクト名から色相を決める（同じ名前は常に同じ色）
function hue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

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
function longDate(s) {
  const d = parseYmd(s);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}
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

function upsertTask(task, { quiet = false } = {}) {
  task.updatedAt = new Date().toISOString();
  const i = state.tasks.findIndex(t => t.id === task.id);
  if (i >= 0) state.tasks[i] = task; else state.tasks.push(task);
  state.pending = state.pending.filter(t => t.id !== task.id);
  state.pending.push(task);
  persist();
  if (!quiet) render();
  scheduleSync();
}

function toggleDone(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const before = { ...t };
  const updated = { ...t, done: !t.done, doneAt: !t.done ? new Date().toISOString() : null };
  upsertTask(updated);
  let next = null;
  // 繰り返しタスクは完了時に次回分を作る
  if (updated.done && t.repeat && t.repeat !== 'none') {
    next = newTask({
      title: t.title, notes: t.notes, dueTime: t.dueTime, priority: t.priority,
      project: t.project, tags: [...t.tags], repeat: t.repeat, notify: t.notify,
      due: nextDue(t.due, t.repeat),
    });
    upsertTask(next);
  }
  if (updated.done) {
    toast(next ? `完了しました ・ 次回 ${formatDue(next.due, next.dueTime)}` : '完了しました', () => {
      upsertTask({ ...before });
      if (next) upsertTask({ ...next, deleted: true });
    });
  }
}

function deleteTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const before = { ...t };
  upsertTask({ ...t, deleted: true });
  toast('削除しました', () => upsertTask({ ...before, deleted: false }));
}

function persist() {
  save(LS.tasks, state.tasks);
  save(LS.pending, state.pending);
}

/* ---------- 絞り込み ---------- */
const live = () => state.tasks.filter(t => !t.deleted);
const open = () => live().filter(t => !t.done);
const doneToday = () => live().filter(t => t.done && t.doneAt && ymd(new Date(t.doneAt)) === today());
// 返信が必要なメールのタスク（新しく届いた順）
const mailTasks = () => open().filter(x => x.source === 'gmail')
  .sort((a, b) => (b.receivedAt || b.createdAt).localeCompare(a.receivedAt || a.createdAt));

function applyFilters(list) {
  const active = FILTERS.filter(f => state.filters.includes(f.id));
  return active.length ? list.filter(t => active.every(f => f.test(t))) : list;
}

function sortTasks(list) {
  return applyFilters(list).slice().sort((a, b) =>
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
  if (view === 'mail') return [{ title: '', items: applyFilters(mailTasks()) }];
  if (view === 'today') {
    const list = open().filter(x => x.due && x.due <= t);
    return [
      { title: '今日の予定', items: eventsOn(t) },
      { title: '要返信メール', items: applyFilters(mailTasks().filter(x => !x.due)) },
      { title: '期限切れ', cls: 'overdue', items: sortTasks(list.filter(x => x.due < t)) },
      { title: '今日のタスク', items: sortTasks(list.filter(x => x.due === t)) },
      { title: '今日完了', items: applyFilters(doneToday()) },
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
    const list = applyFilters(live().filter(x => x.done))
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

function searchGroups(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = t => {
    const hay = [t.title, t.notes, t.project, ...(t.tags || [])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  };
  const list = live().filter(hit);
  return [
    { title: '未完了', items: sortTasks(list.filter(t => !t.done)) },
    { title: '完了済み', items: applyFilters(list.filter(t => t.done)).slice(0, 50) },
  ];
}

function viewTitle(view) {
  if (view.startsWith('project:')) return view.slice(8);
  if (view.startsWith('tag:')) return '@' + view.slice(4);
  return { today: '今日', mail: '要返信', calendar: 'カレンダー', upcoming: '予定', all: 'すべて', done: '完了', settings: '設定' }[view] || '';
}
function viewSubtitle(view) {
  if (view === 'today') return longDate(today());
  if (view === 'mail') return '返信が必要なメール';
  if (view === 'upcoming') return '明日からの予定とタスク';
  if (view.startsWith('project:')) return 'プロジェクト';
  if (view.startsWith('tag:')) return 'タグ';
  return '';
}

/* ---------- 描画 ---------- */
const LIST_VIEWS = v => !['settings', 'calendar'].includes(v);

function render() {
  const view = state.view;
  const searching = !!state.query.trim();
  $('#viewTitle').textContent = searching ? '検索結果' : viewTitle(view);
  $('#viewSubtitle').textContent = searching ? `「${state.query.trim()}」` : viewSubtitle(view);
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));

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

  const isSettings = view === 'settings' && !searching;
  const isCalendar = view === 'calendar' && !searching;
  $('#settings').hidden = !isSettings;
  $('#calendar').hidden = !isCalendar;
  $('#list').hidden = isSettings;
  $('#quickAdd').hidden = isSettings || (!searching && (view === 'done' || view === 'mail'));
  $('#mailBar').hidden = searching || view !== 'mail';
  $('#dashboard').hidden = searching || view !== 'today';
  $('#searchBox').hidden = isSettings;
  renderFilters(!isSettings && (searching || LIST_VIEWS(view)));

  if (isSettings) {
    // 入力途中の内容を消さないよう、設定画面は開いたときに一度だけ描画する
    if (!$('#settings').hasChildNodes()) renderSettings();
    return;
  }
  $('#settings').innerHTML = '';
  if (!$('#dashboard').hidden) renderDashboard();

  let groups;
  if (searching) groups = searchGroups(state.query);
  else if (isCalendar) {
    renderCalendar();
    const d = state.calSelected;
    groups = [{
      title: '', items: [...eventsOn(d), ...sortTasks(live().filter(x => x.due === d && !x.done)),
        ...applyFilters(live().filter(x => x.due === d && x.done))],
    }];
  } else groups = groupsForView(view);

  groups = groups.filter(g => g.items.length);
  let html = isCalendar ? `<div class="cal-day-title">${esc(longDate(state.calSelected))}</div>` : '';
  if (!groups.length) {
    const msg = searching ? '見つかりませんでした'
      : isCalendar ? '予定もタスクもありません'
      : state.filters.length ? '条件に合うタスクはありません'
      : { today: '今日のタスクはありません', mail: '返信が必要なメールはありません' }[view] || 'タスクはありません';
    const emoji = searching ? '🔍' : view === 'mail' ? '📭' : '🎉';
    html += `<div class="empty"><div class="empty-ico">${emoji}</div>${msg}</div>`;
  } else {
    html += groups.map(g => `
      ${g.title ? `<div class="group-title ${g.cls || ''}">${esc(g.title)}<span class="gcount">${g.items.length}</span></div>` : ''}
      ${g.items.map(x => x.kind === 'event' ? eventHtml(x) : taskHtml(x)).join('')}
    `).join('');
  }
  $('#list').innerHTML = html;
}

function renderDashboard() {
  const t = today();
  const h = new Date().getHours();
  const greet = h < 5 ? 'おつかれさまです' : h < 11 ? 'おはようございます' : h < 17 ? 'こんにちは' : 'こんばんは';
  const todayOpen = open().filter(x => x.due && x.due <= t).length;
  const overdue = open().filter(x => x.due && x.due < t).length;
  const doneN = doneToday().length;
  const total = todayOpen + doneN;
  const pct = total ? Math.round(doneN / total * 100) : 0;
  const events = eventsOn(t).length;
  const mails = mailTasks().length;
  const message = !total ? '今日の期限のタスクはありません'
    : pct === 100 ? 'すべて完了！おつかれさまでした 🎉'
    : `あと ${todayOpen} 件`;
  $('#dashboard').innerHTML = `
    <div class="hero">
      <div class="hero-greet">${greet}</div>
      <div class="hero-sub">${esc(message)}</div>
      <div class="progress">
        <div class="progress-top"><span>今日の達成</span><span>${doneN} / ${total}（${pct}%）</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
    </div>
    <div class="stats">
      <button class="stat" data-goto="today"><div class="stat-num">${todayOpen}</div><div class="stat-label">${icon('flag')}今日のタスク</div></button>
      <button class="stat ${overdue ? 'warn' : ''}" data-goto="today"><div class="stat-num">${overdue}</div><div class="stat-label">${icon('alert')}期限切れ</div></button>
      <button class="stat ${mails ? 'mail' : ''}" data-goto="mail"><div class="stat-num">${mails}</div><div class="stat-label">${icon('mail')}要返信</div></button>
      <button class="stat" data-goto="calendar"><div class="stat-num">${events}</div><div class="stat-label">${icon('calendar')}今日の予定</div></button>
    </div>`;
}

function renderFilters(show) {
  if (!show) { $('#filters').innerHTML = ''; return; }
  $('#filters').innerHTML = FILTERS.map(f =>
    `<button class="filter-chip ${state.filters.includes(f.id) ? 'on' : ''}" data-filter="${f.id}">${f.label}</button>`).join('') +
    (state.filters.length ? '<button class="filter-chip" data-filter="clear">クリア</button>' : '');
}

function renderCalendar() {
  if (!state.calSelected) state.calSelected = today();
  if (!state.calMonth) state.calMonth = state.calSelected.slice(0, 7);
  const [y, m] = state.calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - first.getDay());
  const t = today();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = ymd(d);
    const dots = [
      ...eventsOn(ds).map(e => e.color || 'var(--accent)'),
      ...open().filter(x => x.due === ds).map(x => ({ 3: 'var(--p3)', 2: 'var(--p2)', 1: 'var(--p1)' }[x.priority] || 'var(--muted)')),
    ].slice(0, 4);
    const cls = [
      'cal-day', d.getMonth() !== m - 1 && 'other', ds === t && 'today', ds === state.calSelected && 'selected',
      d.getDay() === 0 && 'sun', d.getDay() === 6 && 'sat',
    ].filter(Boolean).join(' ');
    cells += `<button class="${cls}" data-date="${ds}"><span class="cal-num">${d.getDate()}</span><span class="cal-dots">${dots.map(c => `<i style="--c:${esc(c)}"></i>`).join('')}</span></button>`;
  }
  $('#calendar').innerHTML = `
    <div class="cal-card">
      <div class="cal-head">
        <div class="cal-month">${y}年${m}月</div>
        <div class="cal-nav">
          <button class="today-btn" data-cal="today">今日</button>
          <button class="icon-btn" data-cal="prev" aria-label="前の月">${icon('left')}</button>
          <button class="icon-btn" data-cal="next" aria-label="次の月">${icon('right')}</button>
        </div>
      </div>
      <div class="cal-grid">
        ${WEEKDAYS.map((w, i) => `<div class="cal-dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
        ${cells}
      </div>
    </div>`;
}

function taskHtml(x) {
  const t = today();
  const meta = [];
  if (x.due) {
    const cls = !x.done && x.due < t ? 'overdue' : x.due === t ? 'today' : '';
    meta.push(`<span class="meta ${cls}">${icon('calendar')}${esc(formatDue(x.due, x.dueTime))}</span>`);
  }
  if (x.priority) meta.push(`<span class="pill p${x.priority}">${icon('flag')}${PRIORITY_LABEL[x.priority]}</span>`);
  if (x.repeat && x.repeat !== 'none') meta.push(`<span class="meta">${icon('repeat')}${REPEAT_LABEL[x.repeat]}</span>`);
  if (x.notify && x.due) meta.push(`<span class="meta">${icon('bell')}</span>`);
  if (x.source === 'gmail') {
    const d = x.receivedAt ? new Date(x.receivedAt) : null;
    const when = d ? ` ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
    meta.push(`<span class="chip mail">✉︎ 要返信${esc(when)}</span>`);
    if (x.sourceUrl) meta.push(`<a href="${esc(x.sourceUrl)}" target="_blank" rel="noopener">Gmailで開く ↗</a>`);
  }
  if (x.project && state.view !== 'project:' + x.project) meta.push(`<span class="chip proj" style="--h:${hue(x.project)}"># ${esc(x.project)}</span>`);
  for (const tag of x.tags) meta.push(`<span class="chip">@${esc(tag)}</span>`);
  return `
    <div class="task-wrap" data-id="${esc(x.id)}">
      <div class="swipe-bg done-bg">${icon('check')}&nbsp;${x.done ? '未完了に戻す' : '完了'}</div>
      <div class="swipe-bg del-bg">削除</div>
      <div class="task ${x.done ? 'done' : ''}" data-priority="${x.priority}">
        <button class="task-check" data-action="toggle" aria-label="完了">${icon('check')}</button>
        <div class="task-body" data-action="edit">
          <div class="task-title">${esc(x.title)}</div>
          ${x.notes ? `<div class="task-notes">${esc(x.notes)}</div>` : ''}
          ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
        </div>
      </div>
    </div>`;
}

function eventHtml(ev) {
  const time = ev.allDay ? '終日' : `${ev.start.slice(11, 16)} – ${ev.end.slice(11, 16)}`;
  return `
    <div class="event" style="--ev:${esc(ev.color || 'var(--accent)')}">
      <span class="event-time">${esc(time)}</span>
      <span class="event-title">${esc(ev.title)}</span>
      <span class="event-cal">${esc(ev.calendar)}</span>
    </div>`;
}

function renderNavLists() {
  const projects = [...new Set(open().map(x => x.project).filter(Boolean))].sort();
  const tags = [...new Set(open().flatMap(x => x.tags))].sort();
  const active = v => state.view === v ? 'active' : '';
  $('#projectList').innerHTML = projects.length
    ? projects.map(p => `<button class="nav-item ${active('project:' + p)}" data-view="${esc('project:' + p)}"><span class="ico"><i class="proj-dot" style="--h:${hue(p)}"></i></span><span>${esc(p)}</span><span class="count">${open().filter(x => x.project === p).length}</span></button>`).join('')
    : '<div class="empty-nav">#名前 で追加できます</div>';
  $('#tagList').innerHTML = tags.length
    ? tags.map(g => `<button class="nav-item ${active('tag:' + g)}" data-view="${esc('tag:' + g)}"><span class="ico">${icon('tag')}</span><span>${esc(g)}</span><span class="count">${open().filter(x => x.tags.includes(g)).length}</span></button>`).join('')
    : '<div class="empty-nav">@名前 で追加できます</div>';
  $('#projectOptions').innerHTML = projects.map(p => `<option value="${esc(p)}">`).join('');
}

function renderSyncStatus() {
  const el = $('#syncStatus');
  el.className = 'sync-status';
  if (!state.config.apiUrl) { el.textContent = '端末内のみ保存（同期オフ）'; return; }
  if (state.syncing) { el.textContent = '同期中…'; return; }
  if (state.syncError) { el.classList.add('err'); el.textContent = '同期エラー: ' + state.syncError; return; }
  const pend = (state.pending.length ? `・未送信 ${state.pending.length}件` : '') +
    (state.eventsError ? '・予定の取得に失敗' : '');
  if (state.lastSync) el.classList.add('ok');
  el.textContent = state.lastSync
    ? `同期済み ${state.lastSync.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}${pend}`
    : `未同期${pend}`;
}

function renderSettings() {
  const c = state.config;
  $('#settings').innerHTML = `
    <div class="set-card">
      <h3>同期（Mac ⇄ iPhone）</h3>
      <p>Google Apps Script の「ウェブアプリのURL」と「トークン」を入力すると、データが Google スプレッドシートに保存され、Mac と iPhone で同期されます。空のままなら、この端末の中だけに保存されます。</p>
      <label class="set-field">ウェブアプリのURL<input id="cfgUrl" value="${esc(c.apiUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="set-field">トークン<input id="cfgToken" type="password" value="${esc(c.token)}" autocomplete="off"></label>
      <div class="btn-row">
        <button class="btn" id="cfgSave">保存して同期</button>
        <button class="btn ghost" id="cfgTest">接続テスト</button>
      </div>
    </div>

    <div class="set-card">
      <h3>バックアップ</h3>
      <p>すべてのタスクを JSON ファイルとして書き出します。</p>
      <div class="btn-row"><button class="btn ghost" id="exportBtn">書き出す</button></div>
    </div>

    <div class="set-card">
      <h3>操作のヒント</h3>
      <p>
        <b>クイック追加</b>：日付（今日 / 明日 / 明後日 / 金 / 12/25）、時刻（15:00）、優先度（!高 !中 !低）、プロジェクト（#仕事）、タグ（@電話）<br>
        例：「見積書を送る 金 10:00 !高 #仕事 @メール」<br>
        <b>スマホ</b>：タスクを右にスワイプで完了、左にスワイプで削除。右下の ＋ から詳しく追加。<br>
        <b>Mac</b>：「/」で検索、「n」でクイック追加、Esc で閉じる。
      </p>
    </div>

    <div class="set-card">
      <h3>要返信メールの判定ルール</h3>
      <p>
        Gmail の受信トレイ（7日以内）から、次の条件をすべて満たすメールを「要返信」として追加します。返信すると自動で完了になります。<br>
        ・自分が To か Cc に入っていて、まだ返信していない<br>
        ・プロモーション／ソーシャル／新着／フォーラムのカテゴリではない<br>
        ・メルマガ・一斉配信・自動送信（no-reply など）ではない<br>
        対象にしたくないメールは、Gmail で「<b>返信不要</b>」というラベルを付けると除外されます。
      </p>
    </div>`;
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
function openEditor(id, defaults = {}) {
  const isNew = id === 'new';
  const t = isNew ? newTask(defaults) : state.tasks.find(x => x.id === id);
  if (!t) return;
  state.editingId = id;
  state.newDefaults = defaults;
  const f = $('#editForm');
  $('#sheetTitle').textContent = isNew ? '新しいタスク' : 'タスクの編集';
  f.title.value = t.title;
  f.notes.value = t.notes;
  f.due.value = t.due;
  f.dueTime.value = t.dueTime;
  f.querySelector(`[name=priority][value="${t.priority}"]`).checked = true;
  f.repeat.value = t.repeat || 'none';
  f.project.value = t.project;
  f.tags.value = t.tags.join(' ');
  f.notify.checked = !!t.notify;
  const src = $('#sourceInfo');
  src.hidden = !t.sourceUrl;
  src.innerHTML = t.sourceUrl ? `✉︎ 元のメール：<a href="${esc(t.sourceUrl)}" target="_blank" rel="noopener">Gmailで開く ↗</a>` : '';
  $('#deleteTask').hidden = isNew;
  $('#sheetBackdrop').hidden = false;
  if (isNew) setTimeout(() => f.title.focus(), 50);
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
    if (!state.editingId && !swipe.active) render(); else renderSyncStatus();
  }
}

/* ---------- トースト（元に戻す付き） ---------- */
let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  $('#toastMsg').textContent = msg;
  const btn = $('#toastUndo');
  btn.hidden = !undo;
  btn.onclick = () => { el.hidden = true; undo && undo(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 4500 : 2200);
}

/* ---------- スワイプ（スマホ） ---------- */
const swipe = { active: false, el: null, wrap: null, x0: 0, y0: 0, dx: 0, decided: false };
document.addEventListener('touchstart', e => {
  const task = e.target.closest('.task');
  if (!task || e.touches.length > 1) return;
  Object.assign(swipe, { el: task, wrap: task.closest('.task-wrap'), x0: e.touches[0].clientX, y0: e.touches[0].clientY, dx: 0, decided: false, active: false });
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!swipe.el) return;
  const dx = e.touches[0].clientX - swipe.x0;
  const dy = e.touches[0].clientY - swipe.y0;
  if (!swipe.decided) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    swipe.decided = true;
    swipe.active = Math.abs(dx) > Math.abs(dy);
    if (!swipe.active) { swipe.el = null; return; }
  }
  if (!swipe.active) return;
  swipe.dx = dx;
  swipe.el.style.transition = 'none';
  swipe.el.style.transform = `translateX(${dx}px)`;
  swipe.wrap.querySelector('.done-bg').style.opacity = dx > 0 ? Math.min(1, dx / 80) : 0;
  swipe.wrap.querySelector('.del-bg').style.opacity = dx < 0 ? Math.min(1, -dx / 80) : 0;
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!swipe.el) return;
  const { el, wrap, dx, active } = swipe;
  swipe.el = null;
  if (!active) return;
  const id = wrap.dataset.id;
  el.style.transition = '';
  if (dx > 90) {
    el.style.transform = 'translateX(110%)';
    setTimeout(() => { swipe.active = false; toggleDone(id); }, 180);
  } else if (dx < -90) {
    el.style.transform = 'translateX(-110%)';
    setTimeout(() => { swipe.active = false; deleteTask(id); }, 180);
  } else {
    el.style.transform = '';
    wrap.querySelectorAll('.swipe-bg').forEach(b => { b.style.opacity = 0; });
    setTimeout(() => { swipe.active = false; }, 50);
  }
});

/* ---------- イベント ---------- */
function setView(view) {
  state.view = view;
  state.query = '';
  $('#search').value = '';
  save(LS.view, view);
  closeDrawer();
  closeComposer();
  $('#main').scrollTop = 0;
  render();
}
const openDrawer = () => $('#nav').classList.add('open');
const closeDrawer = () => $('#nav').classList.remove('open');

document.addEventListener('click', e => {
  if (swipe.active) return;
  const nav = e.target.closest('[data-view]');
  if (nav) { setView(nav.dataset.view); return; }
  const go = e.target.closest('[data-goto]');
  if (go) { setView(go.dataset.goto); return; }
  const filter = e.target.closest('[data-filter]');
  if (filter) {
    const id = filter.dataset.filter;
    state.filters = id === 'clear' ? [] : state.filters.includes(id) ? state.filters.filter(f => f !== id) : [...state.filters, id];
    save(LS.filters, state.filters);
    render();
    return;
  }
  const day = e.target.closest('[data-date]');
  if (day) {
    state.calSelected = day.dataset.date;
    state.calMonth = state.calSelected.slice(0, 7);
    render();
    return;
  }
  const cal = e.target.closest('[data-cal]');
  if (cal) {
    const [y, m] = state.calMonth.split('-').map(Number);
    if (cal.dataset.cal === 'today') { state.calSelected = today(); state.calMonth = ''; }
    else state.calMonth = ymd(new Date(y, m - 1 + (cal.dataset.cal === 'next' ? 1 : -1), 1)).slice(0, 7);
    render();
    return;
  }
  if (e.target.closest('.task a')) return; // 「Gmailで開く」はそのままリンクを開く
  const act = e.target.closest('[data-action]');
  if (act) {
    const id = act.closest('.task-wrap').dataset.id;
    if (act.dataset.action === 'toggle') {
      const task = act.closest('.task');
      if (!task.classList.contains('done')) {
        task.classList.add('done', 'completing');
        setTimeout(() => toggleDone(id), 260);
      } else toggleDone(id);
    } else openEditor(id);
  }
});

$('#moreTab').addEventListener('click', openDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

$('#fab').addEventListener('click', () => {
  const v = state.view;
  const defaults = {};
  if (v === 'today') defaults.due = today();
  if (v === 'calendar') defaults.due = state.calSelected || today();
  if (v.startsWith('project:')) defaults.project = v.slice(8);
  if (v.startsWith('tag:')) defaults.tags = [v.slice(4)];
  openEditor('new', defaults);
});

$('#search').addEventListener('input', e => { state.query = e.target.value; render(); });

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

/* ---------- 追加フォーム（タスク名と詳細を一度に入力） ---------- */
// 表示中の画面に合わせた初期値
function viewDefaults() {
  const v = state.view;
  const d = {};
  if (v === 'today') d.due = today();
  if (v === 'calendar') d.due = state.calSelected || today();
  if (v.startsWith('project:')) d.project = v.slice(8);
  if (v.startsWith('tag:')) d.tags = [v.slice(4)];
  return d;
}
function resetComposer() {
  const f = $('#quickAdd');
  const d = viewDefaults();
  f.reset();
  f.due.value = d.due || '';
  f.project.value = d.project || '';
  f.tags.value = (d.tags || []).join(' ');
}
function openComposer() {
  const f = $('#quickAdd');
  if (f.classList.contains('open')) return;
  resetComposer();
  f.classList.add('open');
  $('#qaDetails').hidden = false;
}
function closeComposer() {
  const f = $('#quickAdd');
  f.classList.remove('open');
  $('#qaDetails').hidden = true;
  f.reset();
  document.activeElement?.blur();
}
$('#quickInput').addEventListener('focus', openComposer);
$('#qaClose').addEventListener('click', closeComposer);
// 何も入力していなければ、フォームの外をクリックしたときに閉じる
document.addEventListener('pointerdown', e => {
  const f = $('#quickAdd');
  if (!f.classList.contains('open') || f.contains(e.target)) return;
  if (!f.title.value.trim() && !f.notes.value.trim()) closeComposer();
});

$('#quickAdd').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (!f.title.value.trim()) { f.title.focus(); return; }
  // 「明日 15:00 !高 #仕事」のような書き方も読み取り、フォームで指定した値を優先する
  const parsed = parseQuick(f.title.value);
  if (!parsed.title) { toast('タスク名を入力してください'); return; }
  const formTags = f.tags.value.split(/\s+/).map(s => s.replace(/^@/, '')).filter(Boolean);
  const formPriority = Number(f.querySelector('[name=priority]:checked')?.value || 0);
  const due = parsed.due || f.due.value;
  const task = newTask({
    title: parsed.title,
    notes: f.notes.value,
    due,
    dueTime: due ? (parsed.dueTime || f.dueTime.value) : '',
    priority: formPriority || parsed.priority,
    project: parsed.project || f.project.value.trim().replace(/^#/, ''),
    tags: [...new Set([...formTags, ...parsed.tags])],
    repeat: f.repeat.value,
    notify: f.notify.checked,
  });
  upsertTask(task);
  toast(task.due ? `追加しました（${formatDue(task.due, task.dueTime)}）` : '追加しました');
  // 続けて入力できるように、フォームを初期状態に戻してタスク名にカーソルを置く
  resetComposer();
  f.title.focus();
});

$('#editForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const isNew = state.editingId === 'new';
  const base = isNew ? newTask(state.newDefaults) : state.tasks.find(x => x.id === state.editingId);
  if (!base) return closeEditor();
  const title = f.title.value.trim();
  if (!title) { f.title.focus(); return; }
  upsertTask({
    ...base,
    title,
    notes: f.notes.value,
    due: f.due.value,
    dueTime: f.due.value ? f.dueTime.value : '',
    priority: Number(f.querySelector('[name=priority]:checked')?.value || 0),
    repeat: f.repeat.value,
    project: f.project.value.trim().replace(/^#/, ''),
    tags: f.tags.value.split(/\s+/).map(s => s.replace(/^@/, '')).filter(Boolean),
    notify: f.notify.checked,
  });
  closeEditor();
  if (isNew) toast('追加しました');
});
$('#cancelEdit').addEventListener('click', closeEditor);
$('#sheetBackdrop').addEventListener('click', e => { if (e.target.id === 'sheetBackdrop') closeEditor(); });
$('#deleteTask').addEventListener('click', () => {
  const id = state.editingId;
  closeEditor();
  deleteTask(id);
});

// キーボード操作（Mac）
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (state.editingId) closeEditor();
    else if ($('#quickAdd').classList.contains('open')) closeComposer();
    else if (state.query) { state.query = ''; $('#search').value = ''; $('#search').blur(); render(); }
    else closeDrawer();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'n' && !$('#quickAdd').hidden) { e.preventDefault(); $('#quickInput').focus(); }
});

// アプリに戻ってきたとき・オンライン復帰時・1分ごとに同期
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); if (!state.editingId) render(); } });
window.addEventListener('online', sync);
setInterval(() => { if (!document.hidden) sync(); }, 60_000);

// オフライン用の Service Worker
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

fillIcons();
render();
sync();
