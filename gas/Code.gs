/**
 * タスク管理アプリ用 バックエンド（Google Apps Script）
 *
 * 役割:
 *   - Webアプリから送られたタスクを Google スプレッドシートに保存し、全件を返す（Mac ⇄ iPhone 同期）
 *   - 期限のあるタスクを Google カレンダーの「タスク」カレンダーに登録する（通知ONならリマインダー付き）
 *   - Google カレンダーの予定（今日から2週間分）をアプリに返す
 *   - 15分ごとに Gmail を調べ、返信が必要なメールをタスクにする（返信すると自動で完了）
 *
 * 初回だけやること:
 *   1. エディタ上部の関数選択で「setup」を選んで ▶ 実行（権限の確認が出たら許可）
 *   2. 実行ログに表示された「トークン」を控える
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行: 自分
 *        アクセスできるユーザー: 全員
 *      → 表示された URL とトークンを、アプリの「設定」に入力
 *
 * コードを更新したとき:
 *   1. 「setup」を ▶ 実行（新しい権限が必要なら許可）
 *   2. デプロイ → デプロイを管理 → 鉛筆アイコン → バージョン「新バージョン」→ デプロイ
 */

const SHEET_NAME = 'tasks';
const HEADER = ['id', 'updatedAt', 'json', 'eventId', 'eventSig'];
const TASK_CALENDAR_NAME = 'タスク';
const EVENT_DAYS = 15;          // 何日先までの予定を返すか
const EVENT_CACHE_SECONDS = 60;  // 予定の一時保存時間（1分）

/** 初期設定: 保存用スプレッドシート・合言葉（トークン）・タスク用カレンダーを用意する */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty('SPREADSHEET_ID');
  if (!ssId) {
    const ss = SpreadsheetApp.create('タスク管理アプリ データ');
    const sheet = ss.getSheets()[0];
    sheet.setName(SHEET_NAME);
    sheet.setFrozenRows(1);
    ssId = ss.getId();
    props.setProperty('SPREADSHEET_ID', ssId);
  }
  getSheet().getRange(1, 1, 1, HEADER.length).setValues([HEADER]);

  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }

  const cal = getTaskCalendar();

  // 15分ごとに Gmail をチェックするトリガー
  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'checkGmail';
  });
  if (!hasTrigger) ScriptApp.newTrigger('checkGmail').timeBased().everyMinutes(15).create();

  Logger.log('スプレッドシート: https://docs.google.com/spreadsheets/d/' + ssId);
  Logger.log('タスク用カレンダー: ' + cal.getName());
  Logger.log('Gmail の自動チェック: 15分ごと（新規 ' + checkGmail() + ' 件）');
  Logger.log('トークン（アプリの設定に入力）: ' + token);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: '不正なリクエスト' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || body.token !== token) {
    return json({ ok: false, error: 'トークンが違います' });
  }

  try {
    switch (body.action) {
      case 'ping':
        return json({ ok: true });
      case 'checkGmail':
        return json({ ok: true, added: checkGmail() });
      case 'sync': {
        const result = { ok: true, tasks: syncTasks(body.changes || []) };
        try {
          result.events = getEvents();
        } catch (err) {
          result.eventsError = String(err && err.message || err);
        }
        return json(result);
      }
      default:
        return json({ ok: false, error: '不明な action: ' + body.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return json({ ok: true, message: 'タスク管理アプリ API は動いています' });
}

/* =========================================================
   タスクの保存と同期
   ========================================================= */

/**
 * 受け取った変更を保存し、全タスクを返す。
 * 同じタスクが両端末で編集された場合は、updatedAt が新しい方を採用する。
 */
function syncTasks(changes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const sheet = getSheet();
    let rows = readRows(sheet);
    const index = {};
    rows.forEach(function (r, i) { index[r.id] = i; });

    changes.forEach(function (task) {
      if (!task || !task.id) return;
      const i = index[task.id];
      if (i === undefined) {
        index[task.id] = rows.length;
        rows.push({ id: task.id, updatedAt: task.updatedAt, task: task, eventId: '', eventSig: '', dirty: true });
      } else if (String(task.updatedAt) >= String(rows[i].updatedAt)) {
        rows[i].updatedAt = task.updatedAt;
        rows[i].task = task;
        rows[i].dirty = true;
      }
    });

    // カレンダーへの反映（初回はすべてのタスクを対象にする）
    const props = PropertiesService.getScriptProperties();
    const fullSync = props.getProperty('CALENDAR_SYNCED') !== '1';
    const cal = getTaskCalendar();
    // 先に、Google カレンダー側で動かされた予定をタスクに反映する（今回アプリで変更されたタスクは除く）
    if (!fullSync) pullCalendarEdits(cal, rows);
    rows.forEach(function (r) {
      if (fullSync || r.dirty) syncEvent(cal, r);
    });
    if (fullSync) props.setProperty('CALENDAR_SYNCED', '1');

    // 削除から30日以上たったタスクは完全に消す（シートの肥大化防止）
    const limit = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const before = rows.length;
    rows = rows.filter(function (r) { return !(r.task.deleted && r.updatedAt < limit); });

    if (rows.length !== before || rows.some(function (r) { return r.dirty; })) {
      writeRows(sheet, rows);
    }
    return rows.map(function (r) { return r.task; });
  } finally {
    lock.releaseLock();
  }
}

function getSheet() {
  const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('setup() がまだ実行されていません');
  return SpreadsheetApp.openById(ssId).getSheetByName(SHEET_NAME);
}

function readRows(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADER.length).getValues()
    .filter(function (v) { return v[0]; })
    .map(function (v) {
      return {
        id: String(v[0]), updatedAt: String(v[1]), task: JSON.parse(v[2]),
        eventId: String(v[3] || ''), eventSig: String(v[4] || ''), dirty: false,
      };
    });
}

function writeRows(sheet, rows) {
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, HEADER.length).clearContent();
  if (!rows.length) return;
  sheet.getRange(2, 1, rows.length, HEADER.length).setValues(rows.map(function (r) {
    return [r.id, r.updatedAt, JSON.stringify(r.task), r.eventId, r.eventSig];
  }));
}

/* =========================================================
   Google カレンダー連携
   ========================================================= */

/** タスク用カレンダー（なければ作る） */
function getTaskCalendar() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('TASK_CALENDAR_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar(TASK_CALENDAR_NAME, {
      color: CalendarApp.Color.BLUE,
      summary: 'タスク管理アプリが期限付きのタスクを自動で登録するカレンダー',
    });
    props.setProperty('TASK_CALENDAR_ID', cal.getId());
  }
  return cal;
}

/**
 * タスク1件をカレンダーに反映する。
 *   - 未完了で期限あり → 予定を作る（内容が変わったら作り直す）
 *   - 完了・削除・期限なし → 予定を消す
 * 予定の種類:
 *   - 時刻あり         → その時刻から30分の予定
 *   - 時刻なし・通知ON → 当日9:00から15分の予定（9:00に通知）
 *   - 時刻なし・通知OFF→ 終日の予定
 */
function syncEvent(cal, row) {
  const t = row.task;
  const want = !t.deleted && !t.done && !!t.due;
  const sig = want ? JSON.stringify([t.title, t.notes, t.due, t.dueTime, !!t.notify]) : '';
  if (sig === row.eventSig && (!want || row.eventId)) return;

  if (row.eventId) {
    try {
      const old = cal.getEventById(row.eventId);
      if (old) old.deleteEvent();
    } catch (err) { /* すでに手動で消されている場合など */ }
    row.eventId = '';
  }
  if (want) {
    row.eventId = createEvent(cal, t).getId();
  }
  row.eventSig = sig;
  row.dirty = true;
}

function createEvent(cal, t) {
  const p = t.due.split('-').map(Number);
  const desc = (t.notes ? t.notes + '\n\n' : '') + '（タスク管理アプリから自動登録）';
  let ev;
  if (t.dueTime || t.notify) {
    const hm = (t.dueTime || '09:00').split(':').map(Number);
    const start = new Date(p[0], p[1] - 1, p[2], hm[0], hm[1]);
    const minutes = t.dueTime ? 30 : 15;
    ev = cal.createEvent(t.title, start, new Date(start.getTime() + minutes * 60000), { description: desc });
  } else {
    ev = cal.createAllDayEvent(t.title, new Date(p[0], p[1] - 1, p[2]), { description: desc });
  }
  ev.removeAllReminders();
  if (t.notify) ev.addPopupReminder(0);
  return ev;
}

/**
 * Google カレンダーの「タスク」カレンダーで日時やタイトルを変えた場合に、タスク側へ反映する（双方向同期）。
 *   - 予定の日付・時刻・タイトルがタスクと違っていれば、タスクを予定に合わせる
 *   - 予定をまとめて1回で取得するので、タスクが多くても遅くならない
 */
function pullCalendarEdits(cal, rows) {
  const targets = rows.filter(function (r) { return r.eventId && !r.dirty && !r.task.deleted && !r.task.done; });
  if (!targets.length) return;
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const events = {};
  cal.getEvents(new Date(now.getTime() - 120 * 86400000), new Date(now.getTime() + 730 * 86400000))
    .forEach(function (ev) { events[ev.getId()] = ev; });

  targets.forEach(function (r) {
    const ev = events[r.eventId];
    if (!ev) return; // 範囲外、またはカレンダー側で削除された予定はそのまま
    const t = r.task;
    let due, time;
    if (ev.isAllDayEvent()) {
      due = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd');
      time = '';
    } else {
      due = Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd');
      time = Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm');
      // 「時刻なし・通知あり」のタスクは 9:00 の予定として登録しているので、9:00 のままなら時刻なしとみなす
      if (!t.dueTime && t.notify && time === '09:00') time = '';
    }
    const title = ev.getTitle() || t.title;
    if (due === t.due && time === (t.dueTime || '') && title === t.title) return;

    const updated = Object.assign({}, t, { due: due, dueTime: time, title: title, updatedAt: new Date().toISOString() });
    r.task = updated;
    r.updatedAt = updated.updatedAt;
    // 予定は今の状態のままでよいので、作り直さないよう目印を合わせておく
    r.eventSig = JSON.stringify([updated.title, updated.notes, updated.due, updated.dueTime, !!updated.notify]);
    r.dirty = true;
    r.fromCalendar = true;
  });
}

/** 表示中のカレンダーの予定（今日から EVENT_DAYS 日分）。タスク用カレンダーは除く */
function getEvents() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('events');
  if (cached) return JSON.parse(cached);

  const tz = Session.getScriptTimeZone();
  const taskCalId = PropertiesService.getScriptProperties().getProperty('TASK_CALENDAR_ID');
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + EVENT_DAYS * 24 * 3600 * 1000);
  const fmt = function (d, pattern) { return Utilities.formatDate(d, tz, pattern); };

  const events = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (cal.getId() === taskCalId || cal.isHidden() || !cal.isSelected()) return;
    cal.getEvents(start, end).forEach(function (ev) {
      const allDay = ev.isAllDayEvent();
      const s = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
      const e = allDay ? ev.getAllDayEndDate() : ev.getEndTime();
      events.push({
        id: ev.getId() + '_' + s.getTime(),
        title: ev.getTitle() || '(タイトルなし)',
        allDay: allDay,
        start: fmt(s, allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm"),
        end: fmt(e, allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm"),
        calendar: cal.getName(),
        color: cal.getColor(),
      });
    });
  });
  events.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });

  try { cache.put('events', JSON.stringify(events), EVENT_CACHE_SECONDS); } catch (err) { /* 大きすぎる場合は保存しない */ }
  return events;
}

/* =========================================================
   Gmail 連携: 返信が必要なメールをタスクにする
   ========================================================= */

const GMAIL_QUERY = 'in:inbox newer_than:7d -from:me -category:promotions -category:social -category:updates -category:forums -label:返信不要';
const GMAIL_MAX_THREADS = 40;
// 自動送信らしい差出人
const NOREPLY_PATTERN = /(no-?reply|do-?not-?reply|notification|notify|mailer-daemon|postmaster|bounce|newsletter|magazine|^news@)/i;

/**
 * 受信トレイを調べて、返信が必要なメールをタスクとして追加する。
 * あわせて、返信済みになったメールのタスクを自動で完了にする。
 * 戻り値: 新しく追加したタスクの数
 *
 * 判定ルール（すべて満たすもの）:
 *   - 受信トレイにあり、7日以内、プロモーション等のカテゴリではない
 *   - スレッドの最後のメールが自分以外から（＝まだ返信していない）
 *   - 自分が To か Cc に入っている
 *   - メーリングリスト・一斉配信・自動送信ではない
 *   - Gmail で「返信不要」ラベルが付いていない
 */
function checkGmail() {
  const me = myAddresses();
  const tasks = readRows(getSheet()).map(function (r) { return r.task; });
  const byThread = {};
  tasks.forEach(function (t) {
    if (t.source === 'gmail' && t.sourceId) {
      (byThread[t.sourceId] = byThread[t.sourceId] || []).push(t);
    }
  });

  const now = new Date().toISOString();
  const changes = [];
  let added = 0;

  // 1) 返信が必要なメールを探す
  GmailApp.search(GMAIL_QUERY, 0, GMAIL_MAX_THREADS).forEach(function (thread) {
    const msgs = thread.getMessages();
    const last = msgs[msgs.length - 1];
    if (!needsReply(last, me)) return;

    const existing = byThread[thread.getId()] || [];
    // 未完了のタスクがある、または同じメールのタスクを完了済み → 追加しない
    if (existing.some(function (t) { return !t.deleted && !t.done; })) return;
    if (existing.some(function (t) { return t.sourceMessageId === last.getId(); })) return;

    const from = last.getFrom();
    const body = last.getPlainBody().replace(/\s+/g, ' ').trim().slice(0, 200);
    changes.push({
      id: Utilities.getUuid().replace(/-/g, '').slice(0, 16),
      title: '返信: ' + (thread.getFirstMessageSubject() || '(件名なし)'),
      notes: '差出人: ' + from + '\n' + body,
      due: '', dueTime: '', priority: 0, project: '', tags: [], repeat: 'none', notify: false,
      done: false, doneAt: null, deleted: false,
      source: 'gmail', sourceId: thread.getId(), sourceMessageId: last.getId(),
      sourceUrl: 'https://mail.google.com/mail/u/0/#all/' + thread.getId(),
      receivedAt: last.getDate().toISOString(),
      createdAt: now, updatedAt: now,
    });
    added++;
  });

  // 2) 返信済みになったメールのタスクを自動で完了にする
  tasks.forEach(function (t) {
    if (t.source !== 'gmail' || t.done || t.deleted || !t.sourceId) return;
    let thread = null;
    try { thread = GmailApp.getThreadById(t.sourceId); } catch (err) { /* 削除済みなど */ }
    if (!thread) return;
    const msgs = thread.getMessages();
    const last = msgs[msgs.length - 1];
    if (isFromMe(last, me) || thread.isInTrash()) {
      changes.push(Object.assign({}, t, { done: true, doneAt: now, updatedAt: now }));
    }
  });

  if (changes.length) syncTasks(changes);
  return added;
}

function myAddresses() {
  const list = [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases());
  return list.map(function (a) { return a.toLowerCase(); });
}

function emailOf(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

function isFromMe(msg, me) {
  return me.indexOf(emailOf(msg.getFrom())) >= 0;
}

function needsReply(msg, me) {
  if (isFromMe(msg, me)) return false;
  const from = emailOf(msg.getFrom());
  if (NOREPLY_PATTERN.test(from)) return false;

  const recipients = (msg.getTo() + ',' + msg.getCc()).toLowerCase();
  if (!me.some(function (a) { return recipients.indexOf(a) >= 0; })) return false;

  // 一斉配信・自動送信のヘッダー
  if (msg.getHeader('List-Unsubscribe') || msg.getHeader('List-Id')) return false;
  if (/bulk|list|junk/i.test(msg.getHeader('Precedence'))) return false;
  const auto = msg.getHeader('Auto-Submitted');
  if (auto && !/^no$/i.test(auto)) return false;
  return true;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
