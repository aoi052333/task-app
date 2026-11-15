'use strict';

/* =========================================================
   初回設定の案内（オンボーディング）
   - 同期の設定がまだの端末で、初めて開いたときに表示する
   - 「設定」画面の「設定の案内を開く」からいつでも開ける
   ========================================================= */

const OB_KEY = 'taskapp.onboarded';
const OB_CODE_URL = 'https://raw.githubusercontent.com/aoi052333/task-app/main/gas/Code.gs';
const OB_TOTAL = 5; // 手順の数（ようこそ・完了を除く）
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

const ob = { step: 0, code: '', url: '', token: '', tested: false };

function obSteps() {
  return [
    // 0: ようこそ
    {
      title: 'ようこそ',
      body: `
        <p class="ob-lead">タスク管理アプリへようこそ。まずは、使い方を選んでください。</p>
        <ul class="ob-features">
          <li>${icon('check')}タスク・Todo の管理（期限・優先度・繰り返し・まとめて追加）</li>
          <li>${icon('calendar')}Google カレンダーとの連携（予定の表示・タスクの登録・通知）</li>
          <li>${icon('mail')}Gmail の「返信が必要なメール」を自動でタスクに</li>
          <li>${icon('list')}Google ToDo リストへの転記（スマホのウィジェットで表示）</li>
          <li>${icon('repeat')}Mac と iPhone で同期</li>
        </ul>
        <div class="ob-note">
          これらの機能を使うには、あなたの Google アカウントに<b>同期用の小さなプログラム（Google Apps Script）</b>を用意します。
          <b>無料</b>で、データは<b>あなたの Google アカウントの中だけ</b>に保存されます（約15分）。
        </div>`,
      foot: `
        <button class="btn" data-ob="next">同期して使う（おすすめ）</button>
        <button class="btn ghost" data-ob="local">この端末だけで使う</button>`,
    },
    // 1: プロジェクトを作る
    {
      title: 'Apps Script のプロジェクトを作る',
      body: `
        <ol class="ob-list">
          <li>下のボタンを押して、Google Apps Script を開きます。
            <div class="ob-action"><a class="btn" href="https://script.google.com/create" target="_blank" rel="noopener">Apps Script を開く ↗</a></div>
          </li>
          <li>ログイン画面が出たら、<b>Gmail で使っている Google アカウント</b>でログインします。</li>
          <li>「<b>無題のプロジェクト</b>」という画面が開けば OK です。<br>
            <span class="ob-sub">左上の「無題のプロジェクト」を押して、「タスク管理アプリ」などに名前を変えておくと分かりやすくなります。</span></li>
        </ol>
        <div class="ob-note">このあとの手順でも、Apps Script の画面とこの画面を行き来します。Apps Script は別のタブで開いたままにしておいてください。</div>`,
    },
    // 2: コードを貼り付ける
    {
      title: 'プログラムを貼り付ける',
      body: `
        <ol class="ob-list">
          <li>下のボタンで、プログラムをコピーします。
            <div class="ob-action">
              <button class="btn" data-ob="copy">${icon('paste')}プログラムをコピー</button>
              <span class="ob-status" id="obCopyStatus"></span>
            </div>
          </li>
          <li>Apps Script の画面で、<b>コードが書かれている部分</b>（<code>function myFunction() {</code>）をクリックします。</li>
          <li><kbd>${MOD}</kbd>+<kbd>A</kbd>（全部選択）→ <kbd>${MOD}</kbd>+<kbd>V</kbd>（貼り付け）→ <kbd>${MOD}</kbd>+<kbd>S</kbd>（保存）を押します。<br>
            <span class="ob-sub">「タスク管理アプリ用 バックエンド」で始まる長いコードに置き換われば成功です。</span></li>
        </ol>
        <details class="ob-details">
          <summary>Google ToDo リストにも転記したい場合（任意）</summary>
          <ol class="ob-list small">
            <li>Apps Script の画面左にある「<b>サービス</b>」の <b>＋</b> を押します。</li>
            <li>一覧から「<b>Google Tasks API</b>」を選んで「<b>追加</b>」を押します。</li>
          </ol>
        </details>
        <details class="ob-details">
          <summary>コピーできないときは</summary>
          <p class="ob-sub"><a href="${OB_CODE_URL}" target="_blank" rel="noopener">プログラムのページ ↗</a>を開き、${MOD}+A → ${MOD}+C でコピーしてください。</p>
        </details>`,
    },
    // 3: setup を実行して許可
    {
      title: '初期設定を実行して、権限を許可する',
      body: `
        <ol class="ob-list">
          <li>Apps Script の画面上部で、関数の欄が「<b>setup</b>」になっていることを確認し、<b>▶ 実行</b> を押します。</li>
          <li>「承認が必要です」と出たら「<b>権限を確認</b>」を押し、自分のアカウントを選びます。</li>
          <li>「<b>このアプリは Google で確認されていません</b>」と出たら、左下の「<b>詳細</b>」→「<b>（安全ではないページ）に移動</b>」→「<b>許可</b>」を押します。</li>
          <li>画面下の「実行ログ」に、<code>トークン（アプリの設定に入力）: ○○○○</code> と表示されたら成功です。<br>
            <span class="ob-sub">この英数字（トークン）を<b>コピーしておいてください</b>。最後の手順で使います。</span></li>
        </ol>
        <div class="ob-note">
          <b>警告が出るのはなぜ？</b> あなた自身が作ったプログラムで、Google の審査を受けていないために表示されます。
          プログラムはあなたのアカウントの中だけで動き、ほかの人がデータを見ることはありません。
        </div>`,
    },
    // 4: デプロイ
    {
      title: 'ウェブアプリとして公開する',
      body: `
        <ol class="ob-list">
          <li>Apps Script の右上にある「<b>デプロイ</b>」→「<b>新しいデプロイ</b>」を押します。</li>
          <li>「種類の選択」の横の <b>⚙（歯車）</b>を押して、「<b>ウェブアプリ</b>」を選びます。</li>
          <li>次のように設定して、「<b>デプロイ</b>」を押します。
            <table class="ob-table">
              <tr><th>次のユーザーとして実行</th><td><b>自分</b></td></tr>
              <tr><th>アクセスできるユーザー</th><td><b>全員</b></td></tr>
            </table>
          </li>
          <li>「アクセスを承認」と出たら、前の手順と同じように許可します。</li>
          <li>表示された「<b>ウェブアプリ</b>」の URL（<code>https://script.google.com/macros/s/…/exec</code>）を<b>コピー</b>します。</li>
        </ol>
        <div class="ob-note">「全員」にしても、トークンを知らない人はデータを読み書きできません。トークンは他の人に教えないでください。</div>`,
    },
    // 5: アプリとつなぐ
    {
      title: 'アプリとつなぐ',
      body: `
        <p class="ob-lead">コピーした URL とトークンを貼り付けて、「接続テスト」を押してください。</p>
        <label class="ob-field">ウェブアプリの URL
          <input id="obUrl" value="${esc(ob.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" inputmode="url">
        </label>
        <label class="ob-field">トークン
          <input id="obToken" value="${esc(ob.token)}" placeholder="実行ログに表示された英数字" autocomplete="off">
        </label>
        <div class="ob-action">
          <button class="btn ghost" data-ob="test">接続テスト</button>
          <span class="ob-status" id="obTestStatus"></span>
        </div>`,
      nextLabel: '保存して始める',
    },
    // 6: 完了
    {
      title: '設定が完了しました 🎉',
      body: `
        <p class="ob-lead">この端末で同期が始まりました。さっそくタスクを追加してみましょう。</p>
        <ul class="ob-features">
          <li>${icon('repeat')}<span><b>iPhone でも使うとき：</b>Safari で同じページを開き、共有ボタン →「ホーム画面に追加」。ホーム画面のアプリを開いて、同じ URL とトークンを入力します（ホーム画面のアプリと Safari は保存場所が別です）。</span></li>
          <li>${icon('list')}<span><b>ウィジェットで見るとき：</b>「Google ToDo リスト」アプリを入れ、ウィジェットのリストを「タスク管理アプリ」にします（Google Tasks API を追加した場合）。</span></li>
          <li>${icon('sliders')}<span>URL とトークンは「設定」画面でいつでも確認・変更できます。トークンを忘れたときは、Apps Script で setup をもう一度実行すると表示されます。</span></li>
        </ul>`,
      foot: `<button class="btn" data-ob="finish">使い始める</button>`,
    },
  ];
}

function renderOnboarding() {
  const steps = obSteps();
  const s = steps[ob.step];
  const isStep = ob.step >= 1 && ob.step <= OB_TOTAL;
  const dots = isStep
    ? `<div class="ob-progress">${Array.from({ length: OB_TOTAL }, (_, i) =>
        `<i class="${i + 1 < ob.step ? 'done' : i + 1 === ob.step ? 'on' : ''}"></i>`).join('')}
        <span>手順 ${ob.step} / ${OB_TOTAL}</span></div>`
    : '';
  const foot = s.foot || `
    <button class="link-btn" data-ob="back">← 戻る</button>
    <button class="btn" data-ob="next">${s.nextLabel || '次へ'}</button>`;
  $('#onboard').innerHTML = `
    <div class="ob-card" role="dialog" aria-modal="true" aria-label="初回設定の案内">
      <div class="ob-head">
        ${dots}
        <button class="link-btn ob-skip" data-ob="close">${ob.step === OB_TOTAL + 1 ? '' : 'あとで設定する'}</button>
      </div>
      <h2 class="ob-title">${s.title}</h2>
      <div class="ob-body">${s.body}</div>
      <div class="ob-foot">${foot}</div>
    </div>`;
  $('#onboard').querySelector('.ob-body').scrollTop = 0;
  if (ob.step === 2 && !ob.code) prefetchCode();
}

// コピーボタンを押した瞬間にコピーできるよう、先にプログラムを読み込んでおく
async function prefetchCode() {
  const st = () => $('#obCopyStatus');
  try {
    const res = await fetch(OB_CODE_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error();
    ob.code = await res.text();
    if (st()) st().textContent = '';
  } catch {
    if (st()) st().textContent = '読み込めませんでした。「コピーできないときは」を見てください';
  }
}

function openOnboarding(step = 0) {
  ob.step = step;
  ob.url = state.config.apiUrl || ob.url;
  ob.token = state.config.token || ob.token;
  $('#onboard').hidden = false;
  document.body.classList.add('ob-open');
  renderOnboarding();
}
function closeOnboarding(mark) {
  if (mark) { try { localStorage.setItem(OB_KEY, mark); } catch { /* 保存できなくても閉じる */ } }
  $('#onboard').hidden = true;
  document.body.classList.remove('ob-open');
}

function obReadInputs() {
  const u = $('#obUrl'), t = $('#obToken');
  if (u) ob.url = u.value.trim();
  if (t) ob.token = t.value.trim();
}

async function obTest() {
  obReadInputs();
  const st = $('#obTestStatus');
  st.className = 'ob-status';
  st.textContent = '確認中…';
  try {
    const res = await api({ action: 'ping' }, { apiUrl: ob.url, token: ob.token });
    if (!res.ok) throw new Error(res.error || '失敗しました');
    ob.tested = true;
    st.classList.add('ok');
    st.textContent = '✓ 接続できました';
    return true;
  } catch (e) {
    ob.tested = false;
    st.classList.add('err');
    st.textContent = '✕ ' + (e.message === 'Failed to fetch' ? 'つながりません。URL を確認してください' : e.message);
    return false;
  }
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-ob]');
  if (!b || !b.closest('#onboard')) return;
  const act = b.dataset.ob;
  if (act === 'next') {
    if (ob.step === OB_TOTAL) {
      // 最後の手順：接続できたら保存して完了画面へ
      if (!(await obTest())) return;
      saveSyncConfig(ob.url, ob.token);
    }
    ob.step++;
    renderOnboarding();
  } else if (act === 'back') {
    obReadInputs();
    ob.step = Math.max(0, ob.step - 1);
    renderOnboarding();
  } else if (act === 'local') {
    closeOnboarding('local');
    toast('この端末だけで使います。同期は「設定」からいつでも始められます');
  } else if (act === 'close') {
    obReadInputs();
    closeOnboarding('later');
    toast('設定の案内は「設定」画面からいつでも開けます');
  } else if (act === 'finish') {
    closeOnboarding('done');
    render();
  } else if (act === 'copy') {
    const st = $('#obCopyStatus');
    if (!ob.code) { await prefetchCode(); }
    if (!ob.code) return;
    const ok = await copyText(ob.code);
    st.className = 'ob-status ' + (ok ? 'ok' : 'err');
    st.textContent = ok ? `✓ コピーしました（${ob.code.split('\n').length}行）` : '✕ コピーできませんでした。「コピーできないときは」を見てください';
  } else if (act === 'test') {
    obTest();
  }
});

// 同期の設定がまだで、案内をまだ閉じていなければ表示する
(function initOnboarding() {
  let seen = null;
  try { seen = localStorage.getItem(OB_KEY); } catch { /* 読めなければ未表示扱い */ }
  if (!state.config.apiUrl && !seen) openOnboarding(0);
})();
