/**
 * タスク管理アプリ用 バックエンド（Google Apps Script）
 *
 * 役割:
 *   - Webアプリから送られたタスクを Google スプレッドシートに保存し、全件を返す（Mac ⇄ iPhone 同期）
 *
 * 初回だけやること:
 *   1. エディタ上部の関数選択で「setup」を選んで ▶ 実行（権限の確認が出たら許可）
 *   2. 実行ログに表示された「トークン」を控える
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行: 自分
 *        アクセスできるユーザー: 全員
 *      → 表示された URL とトークンを、アプリの「設定」に入力
 */

const SHEET_NAME = 'tasks';

/** 初期設定: 保存用スプレッドシートと合言葉（トークン）を作る */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty('SPREADSHEET_ID');
  if (!ssId) {
    const ss = SpreadsheetApp.create('タスク管理アプリ データ');
    const sheet = ss.getSheets()[0];
    sheet.setName(SHEET_NAME);
    sheet.appendRow(['id', 'updatedAt', 'json']);
    sheet.setFrozenRows(1);
    ssId = ss.getId();
    props.setProperty('SPREADSHEET_ID', ssId);
  }
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  Logger.log('スプレッドシート: https://docs.google.com/spreadsheets/d/' + ssId);
  Logger.log('トークン（アプリの設定に入力）: ' + token);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: '不正なリクエスト' });
  }
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TOKEN');
  if (!token || body.token !== token) {
    return json({ ok: false, error: 'トークンが違います' });
  }

  try {
    switch (body.action) {
      case 'ping':
        return json({ ok: true });
      case 'sync':
        return json({ ok: true, tasks: syncTasks(body.changes || []) });
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

/**
 * 受け取った変更を保存し、全タスクを返す。
 * 同じタスクが両端末で編集された場合は、updatedAt が新しい方を採用する。
 */
function syncTasks(changes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const rows = readRows(sheet);
    const index = {};
    rows.forEach(function (r, i) { index[r.id] = i; });

    changes.forEach(function (task) {
      if (!task || !task.id) return;
      const i = index[task.id];
      if (i === undefined) {
        index[task.id] = rows.length;
        rows.push({ id: task.id, updatedAt: task.updatedAt, task: task, dirty: true });
      } else if (String(task.updatedAt) >= String(rows[i].updatedAt)) {
        rows[i] = { id: task.id, updatedAt: task.updatedAt, task: task, dirty: true };
      }
    });

    writeRows(sheet, rows);
    purgeOldDeleted(sheet);

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
  return sheet.getRange(2, 1, last - 1, 3).getValues()
    .filter(function (v) { return v[0]; })
    .map(function (v) {
      return { id: String(v[0]), updatedAt: String(v[1]), task: JSON.parse(v[2]) };
    });
}

function writeRows(sheet, rows) {
  if (!rows.some(function (r) { return r.dirty; })) return;
  const values = rows.map(function (r) {
    return [r.id, r.updatedAt, JSON.stringify(r.task)];
  });
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 3).clearContent();
  if (values.length) sheet.getRange(2, 1, values.length, 3).setValues(values);
}

/** 削除から30日以上たったタスクを完全に消す（シートの肥大化防止） */
function purgeOldDeleted(sheet) {
  const rows = readRows(sheet);
  const limit = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const kept = rows.filter(function (r) { return !(r.task.deleted && r.updatedAt < limit); });
  if (kept.length === rows.length) return;
  kept.forEach(function (r) { r.dirty = true; });
  const last = sheet.getLastRow();
  sheet.getRange(2, 1, last - 1, 3).clearContent();
  if (kept.length) {
    sheet.getRange(2, 1, kept.length, 3).setValues(kept.map(function (r) {
      return [r.id, r.updatedAt, JSON.stringify(r.task)];
    }));
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
