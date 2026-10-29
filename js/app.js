import { store, history, account } from './store.js';
import {
  MAX_PLAYERS, MIN_PLAYERS, randomRoomId, randomId, shuffle, deal,
  revealOrder, liveWrong, lisMarks, isSuccess,
} from './logic.js';
import { TOPIC_MODES, FREE_ID, topicsFor } from './topics.js';
import { setupDrag } from './drag.js';

const GAME_TITLE = 'かずならべ';
const SPIN_FRESH_MS = 4000; // これより古いルーレットは、あとから入った人には演出せず結果だけ見せる

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
let roomId = params.get('room')?.toUpperCase() ?? null;

// プレイヤーID＝Firebase のログインID（起動時に決まる）
let pid = null;

let state = null;
let unsubscribe = null;
let myHand = {}; // 自分の手札の数字 { カードID: 数字 }
let unsubHand = null;
let values = {}; // 答え合わせ中に読める全カードの数字
let unsubValues = null;
let dragging = false;
let composing = false;
let renderQueued = false;
let spinAnim = null; // { id, text }
let lastSpinId = null;
let lastRevealCount = 0;
let historyOpen = false;

// ---------- 共通 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function playersOf(s) {
  return Object.entries(s.players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

function nameOf(s, id) {
  return s.players[id]?.name ?? '（退出した人）';
}

const valueOf = (id) => values[id] ?? myHand[id] ?? null;
const valuesReady = () => state.line.every((id) => values[id] != null);
const isHost = () => state?.hostId === pid;
const update = (fn) => store.update(roomId, fn);
const inviteUrl = () => `${location.origin}${location.pathname}?room=${roomId}`;

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// 中身が変わったときだけ書き換える。入力中の文字とカーソル位置は保持する。
function patch(el, html) {
  if (!el || el._html === html) return;
  const kept = {};
  el.querySelectorAll('[data-keep]').forEach((input) => {
    kept[input.dataset.keep] = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
  });
  const focusKey = el.contains(document.activeElement) ? document.activeElement.dataset?.keep : null;
  el.innerHTML = html;
  el._html = html;
  el.querySelectorAll('[data-keep]').forEach((input) => {
    const k = kept[input.dataset.keep];
    if (k && input.tagName !== 'SELECT') input.value = k.value;
    if (input.dataset.keep === focusKey) {
      input.focus();
      if (k && input.setSelectionRange) input.setSelectionRange(k.start, k.end);
    }
  });
}

// ---------- 入室 ----------

function renderEntry({ mode, error = '' }) {
  const saved = localStorage.getItem('knr:lastName') ?? '';
  app.innerHTML = `
    <main class="entry">
      <h1 class="logo">${GAME_TITLE}<small>（仮）</small></h1>
      <p class="tagline">数字をひとことで伝えて、みんなで小さい順に並べよう</p>
      <form class="entry-card" id="entry-form">
        ${mode === 'join' ? `<p class="entry-room">部屋 <b>${esc(roomId)}</b> に参加します</p>` : ''}
        <label class="field">
          <span>ユーザー名</span>
          <input id="name-input" maxlength="12" autocomplete="off" required value="${esc(saved)}" placeholder="例：たろう">
        </label>
        <button class="btn primary big" type="submit">${mode === 'join' ? '参加する' : '部屋を作る'}</button>
        <p class="error">${esc(error)}</p>
      </form>
      ${mode === 'create' ? googleBoxHtml() : ''}
    </main>`;
  const input = document.getElementById('name-input');
  input.focus();
  document.getElementById('google-login')?.addEventListener('click', async () => {
    try {
      await account.loginWithGoogle();
      pid = account.user.uid;
      renderEntry({ mode });
    } catch (err) {
      renderEntry({ mode, error: err.code === 'auth/popup-closed-by-user' ? '' : `ログインできませんでした（${err.code ?? err.message}）` });
    }
  });
  document.getElementById('google-logout')?.addEventListener('click', async () => {
    await account.logout();
    pid = account.user.uid;
    renderEntry({ mode });
  });
  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    localStorage.setItem('knr:lastName', name);
    if (mode === 'join') await joinRoom(name);
    else await createRoom(name);
  });
}

function googleBoxHtml() {
  if (account.isGoogle) {
    const u = account.user;
    return `
      <div class="google-box">
        <span>Google でログイン中：<b>${esc(u.displayName ?? u.email ?? '')}</b><br><span class="hint">この部屋のゲーム履歴が保存されます</span></span>
        <button class="btn ghost" id="google-logout" type="button">ログアウト</button>
      </div>`;
  }
  return `
    <div class="google-box">
      <span class="hint">ホストとして履歴を残したい場合は、部屋を作る前に Google でログインしてください（参加者はログイン不要）</span>
      <button class="btn" id="google-login" type="button">Google でログイン</button>
    </div>`;
}

function renderMessage(title, body, button) {
  app.innerHTML = `
    <main class="entry">
      <h1 class="logo">${GAME_TITLE}<small>（仮）</small></h1>
      <div class="entry-card">
        <h2>${esc(title)}</h2>
        <p>${esc(body)}</p>
        ${button ? `<button class="btn primary" id="msg-btn">${esc(button.label)}</button>` : ''}
      </div>
    </main>`;
  if (button) document.getElementById('msg-btn').addEventListener('click', button.onClick);
}

async function createRoom(name) {
  let id = randomRoomId();
  while (await store.get(id)) id = randomRoomId();
  await store.create(id, {
    id,
    hostId: pid,
    createdAt: store.now(),
    players: { [pid]: { name, joinedAt: store.now() } },
    phase: 'lobby', // lobby → topic → playing → reveal → lobby …
    settings: { perPlayer: 1 },
    topic: newTopic(),
    cards: {},
    line: [],
    staging: [],
    reveal: null, // { direction: 'asc' | 'desc', count }
    round: 0,
    savedRound: 0,
  });
  roomId = id;
  window.history.replaceState(null, '', `?room=${id}`);
  enterRoom();
}

async function joinRoom(name) {
  let error = '';
  const result = await update((s) => {
    error = '';
    if (s.players[pid]) return s;
    if (Object.keys(s.players).length >= MAX_PLAYERS) {
      error = `この部屋は満員です（最大${MAX_PLAYERS}人）`;
      return undefined;
    }
    s.players[pid] = { name, joinedAt: store.now() };
    return s;
  });
  if (!result) error = 'この部屋は見つかりませんでした';
  if (error) renderEntry({ mode: 'join', error });
  else enterRoom();
}

// ---------- 部屋 ----------

function enterRoom() {
  app.innerHTML = `
    <div class="room">
      <header class="topbar">
        <div class="logo small">${GAME_TITLE}<small>（仮）</small></div>
        <div class="topbar-right">
          <span class="room-code">部屋 <b>${esc(roomId)}</b></span>
          <button class="btn ghost" data-action="copy-invite">招待リンクをコピー</button>
          <button class="btn ghost" data-action="open-history" id="history-btn" hidden>履歴</button>
        </div>
      </header>
      <section id="players" class="players"></section>
      <section id="topic" class="topic-bar"></section>
      <section id="stage" class="stage"></section>
      <section id="controls" class="controls"></section>
    </div>
    <div id="modal"></div>`;
  unsubscribe?.();
  unsubscribe = store.subscribe(roomId, (s) => {
    state = s;
    requestRender();
  });
  unsubHand?.();
  unsubHand = store.subscribeHand(roomId, pid, (hand) => {
    myHand = hand;
    if (state) requestRender();
  });
}

// 答え合わせ中だけ全カードの数字を読み込む
function syncValues() {
  if (state.phase === 'reveal') {
    if (unsubValues) return;
    unsubValues = store.subscribeValues(roomId, (v) => {
      values = v;
      requestRender();
    }, () => {
      // まだ答え合わせ中になっていない（読む許可がない）ときは、次の更新でやり直す
      unsubValues = null;
    });
  } else if (unsubValues || Object.keys(values).length) {
    unsubValues?.();
    unsubValues = null;
    values = {};
  }
}

function requestRender() {
  if (dragging || composing) {
    renderQueued = true;
    return;
  }
  renderQueued = false;
  render();
}

function render() {
  if (!state) {
    renderMessage('部屋が見つかりません', 'この部屋はなくなったようです。', { label: 'トップへ', onClick: goHome });
    return;
  }
  if (!state.players[pid]) {
    renderMessage('部屋から外れました', 'もう一度参加できます。', {
      label: '参加し直す',
      onClick: () => renderEntry({ mode: 'join' }),
    });
    unsubscribe?.();
    return;
  }
  if (!document.getElementById('stage')) enterRoom();

  syncValues();
  startSpinIfNew();
  document.getElementById('history-btn').hidden = !isHost();
  patch(document.getElementById('players'), playersHtml());
  const topicEl = document.getElementById('topic');
  topicEl.hidden = state.phase === 'lobby';
  patch(topicEl, state.phase === 'lobby' ? '' : topicHtml());
  patch(document.getElementById('stage'), stageHtml());
  patch(document.getElementById('controls'), controlsHtml());
  if (historyOpen && !isHost()) actions['close-history']();
  saveHistoryIfDone();
  if (state.phase !== 'reveal') lastRevealCount = 0;
  else lastRevealCount = state.reveal?.count ?? 0;
}

function goHome() {
  unsubscribe?.();
  unsubHand?.();
  roomId = null;
  window.history.replaceState(null, '', location.pathname);
  renderEntry({ mode: 'create' });
}

// ---------- 参加者 ----------

function playersHtml() {
  const s = state;
  const inGame = s.phase === 'playing' || s.phase === 'reveal';
  return playersOf(s).map((p) => {
    const hand = Object.values(s.cards).filter((c) => c.owner === p.id);
    const left = hand.filter((c) => !c.played).length;
    const status = !inGame ? '' : hand.length === 0 ? '<span class="chip-sub">観戦</span>'
      : left > 0 ? `<span class="chip-sub">手札${left}枚</span>` : '<span class="chip-sub done">出しきり</span>';
    const remove = isHost() && (s.phase === 'lobby' || s.phase === 'topic') && p.id !== pid
      ? `<button class="chip-x" data-action="remove-player" data-id="${p.id}" title="部屋から外す">×</button>` : '';
    return `<span class="chip ${p.id === pid ? 'me' : ''}">
      ${p.id === s.hostId ? '<span class="crown" title="ホスト">👑</span>' : ''}
      ${esc(p.name)}${p.id === pid ? '<span class="chip-sub">あなた</span>' : ''}${status}${remove}
    </span>`;
  }).join('') + `<span class="players-count">${Object.keys(s.players).length}/${MAX_PLAYERS}人</span>`;
}

// ---------- お題 ----------

function topicHtml() {
  const t = state.topic;
  if (spinAnim) {
    return `<div class="topic-label">お題</div><div class="topic-text reel"><span id="reel-text">${esc(spinAnim.text)}</span></div>`;
  }
  if (!t.current) {
    const waiting = t.step === 'input' ? 'みんなでお題を考えています…'
      : t.step === 'vote' ? 'やりたいお題に投票してください'
      : isHost() ? 'ジャンルを選んでルーレットを回してください' : 'ホストがお題を選んでいます…';
    return `<div class="topic-label">お題</div><div class="topic-text empty">${waiting}</div>`;
  }
  const by = t.by ? `<div class="topic-by">${esc(nameOf(state, t.by))} さんの案</div>` : '';
  return `<div class="topic-label">お題</div><div class="topic-text">${esc(t.current)}</div>${by}`;
}

function startSpinIfNew() {
  const spin = state.topic.spin;
  if (!spin || spin.id === lastSpinId) return;
  lastSpinId = spin.id;
  if (store.now() - spin.at > SPIN_FRESH_MS) return;
  // だんだん遅くなりながらお題が切り替わり、最後に結果で止まる
  const steps = 18;
  const items = spin.items.length ? spin.items : [spin.result];
  spinAnim = { id: spin.id, text: items[0] };
  let i = 0;
  const tick = () => {
    if (spinAnim?.id !== spin.id) return;
    i++;
    if (i >= steps) {
      spinAnim = null;
      requestRender();
      return;
    }
    spinAnim.text = i === steps - 1 ? spin.result : items[i % items.length];
    const el = document.getElementById('reel-text');
    if (el) {
      el.textContent = spinAnim.text;
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
    setTimeout(tick, 40 + i * i * 1.2);
  };
  setTimeout(tick, 45);
}

function spinTopic(list, pick) {
  const items = shuffle(list).slice(0, 14);
  return { id: randomId(), at: store.now(), items, result: pick };
}

function newTopic() {
  return { current: null, by: null, step: 'choose', genre: null, submissions: {}, votes: {}, tally: null, spin: null };
}

// 自由入力で出されたお題（おまかせを除く）
function candidatesOf(s) {
  return Object.entries(s.topic.submissions)
    .filter(([, text]) => text)
    .map(([owner, text]) => ({ owner, text }));
}

// 投票を集計してお題を決める。同票ならその中からランダム（ルーレット演出つき）
function decideByVote(s) {
  const cands = candidatesOf(s);
  if (cands.length === 0) return s;
  const tally = Object.fromEntries(cands.map((c) => [c.owner, 0]));
  Object.values(s.topic.votes).forEach((owner) => {
    if (owner in tally) tally[owner] += 1;
  });
  const max = Math.max(...Object.values(tally));
  const top = cands.filter((c) => tally[c.owner] === max);
  const win = top[Math.floor(Math.random() * top.length)];
  s.topic.current = win.text;
  s.topic.by = win.owner;
  s.topic.tally = tally;
  s.topic.spin = top.length > 1 ? spinTopic(top.map((c) => c.text), win.text) : null;
  return s;
}

// ---------- メインエリア ----------

function stageHtml() {
  const s = state;
  if (s.phase === 'lobby') return lobbyStageHtml();
  if (s.phase === 'topic') {
    if (s.topic.step === 'input') return inputStageHtml();
    if (s.topic.step === 'vote') return voteStageHtml();
    return genreStageHtml();
  }
  return `${lineHtml()}${s.phase === 'playing' ? stagingHtml() : resultHtml()}`;
}

function lobbyStageHtml() {
  const s = state;
  return `
    <div class="panel howto">
      <h3>遊び方</h3>
      <ol>
        <li>みんながそろったら、ホストが枚数を決めてゲームを始めます。</li>
        <li>ジャンルを選んでルーレットを回すか、みんなでお題を出し合って投票してお題を決めます。</li>
        <li>配られた数字（1〜100）を、お題に沿った「ひとこと」で表現してカードを出します。</li>
        <li>出されたカードは待機エリアに置かれます。みんなで相談して、小さい順になるよう列に並べます。</li>
        <li>並びが決まったら、ホストが答え合わせをして1枚ずつめくります。</li>
      </ol>
      ${Object.keys(s.players).length < MIN_PLAYERS ? `<p class="hint">「招待リンクをコピー」で友達を呼びましょう（${MIN_PLAYERS}人から遊べます）</p>` : ''}
    </div>`;
}

function genreStageHtml() {
  const s = state;
  const host = isHost();
  return `
    <div class="panel">
      <h3>ジャンルを選ぶ ${host ? '<span class="hint">押すとルーレットが回ります。もう一度押すと回し直せます</span>' : '<span class="hint">ホストが選びます</span>'}</h3>
      <div class="genre-grid">
        ${TOPIC_MODES.map((m) => `
          <button class="genre-box ${s.topic.genre === m.id ? 'selected' : ''} ${m.id === FREE_ID ? 'free' : ''}"
            data-action="choose-genre" data-id="${m.id}" ${host ? '' : 'disabled'}>
            <span class="genre-icon">${m.icon}</span>
            <span class="genre-name">${m.name}</span>
            ${m.id === FREE_ID ? '<span class="genre-sub">みんなで出し合う</span>' : ''}
          </button>`).join('')}
      </div>
    </div>`;
}

function inputStageHtml() {
  const s = state;
  const subs = s.topic.submissions;
  const players = playersOf(s);
  const doneCount = players.filter((p) => p.id in subs).length;
  const mine = subs[pid];
  const form = mine === undefined ? `
      <form class="topic-input" data-form="submit-topic">
        <input data-keep="topic-input" maxlength="40" placeholder="やってみたいお題を入力" autocomplete="off">
        <div class="topic-input-buttons">
          <button class="btn primary" type="submit">決定</button>
          <button class="btn" type="button" data-action="omakase">おまかせ</button>
        </div>
      </form>` : `
      <div class="topic-submitted">
        <p>${mine ? `「<b>${esc(mine)}</b>」を出しました` : '<b>おまかせ</b>にしました'}</p>
        <button class="btn ghost" data-action="redo-topic">入力し直す</button>
      </div>`;
  return `
    <div class="panel input-panel">
      <h3>お題を考えよう <span class="hint">全員が入力するまで、誰が何を書いたかは見えません</span></h3>
      ${form}
      <div class="progress">
        <div class="progress-label">入力済み ${doneCount}/${players.length}人</div>
        <div class="progress-row">
          ${players.map((p) => `<span class="progress-chip ${p.id in subs ? 'done' : ''}">${p.id in subs ? '✓' : '…'} ${esc(p.name)}</span>`).join('')}
        </div>
      </div>
    </div>`;
}

function voteStageHtml() {
  const s = state;
  const t = s.topic;
  const cands = candidatesOf(s);
  const omakase = Object.entries(t.submissions).filter(([, text]) => !text).map(([id]) => nameOf(s, id));
  const decided = !!t.current;
  if (cands.length === 0) {
    return `<div class="panel waiting">お題が1つも出ませんでした（全員おまかせ）。${isHost() ? 'ジャンル選びに戻ってください。' : 'ホストがやり直します。'}</div>`;
  }
  const players = playersOf(s);
  const voted = players.filter((p) => p.id in t.votes).length;
  return `
    <div class="panel">
      <h3>${decided ? '投票結果' : 'やりたいお題に投票'} ${decided ? '' : `<span class="hint">投票済み ${voted}/${players.length}人。全員が投票すると決まります（同票ならランダム）</span>`}</h3>
      <ul class="vote-list">
        ${cands.map((c) => {
          const mineVote = t.votes[pid] === c.owner;
          const win = decided && t.by === c.owner;
          return `
            <li class="${mineVote ? 'voted' : ''} ${win && !spinAnim ? 'winner' : ''}">
              <span class="cand-text">${esc(c.text)}</span>
              <span class="cand-by">${esc(nameOf(s, c.owner))}</span>
              ${decided ? `<span class="vote-count">${t.tally?.[c.owner] ?? 0}票</span>`
                : `<button class="btn small ${mineVote ? 'primary' : ''}" data-action="vote" data-id="${c.owner}">${mineVote ? '投票中' : '投票する'}</button>`}
            </li>`;
        }).join('')}
      </ul>
      ${omakase.length ? `<p class="hint">おまかせ：${omakase.map(esc).join('、')}</p>` : ''}
    </div>`;
}

function cardHtml(card, { faceUp = false, draggable = false, classes = '' } = {}) {
  return `
    <div class="card ${faceUp ? 'face' : 'back'} ${classes}" data-card="${card.id}" ${draggable ? `data-drag="${card.id}"` : ''} title="${esc(nameOf(state, card.owner))}：${esc(card.word)}">
      <div class="card-owner">${esc(nameOf(state, card.owner))}</div>
      ${faceUp ? `<div class="card-num">${valueOf(card.id) ?? '…'}</div>` : '<div class="card-mark">?</div>'}
      <div class="card-word">${esc(card.word)}</div>
    </div>`;
}

function lineHtml() {
  const s = state;
  const playing = s.phase === 'playing';
  let inner;
  if (playing) {
    inner = s.line.map((id) => cardHtml(s.cards[id], { draggable: true })).join('');
  } else {
    const { direction, count } = s.reveal;
    const ready = valuesReady();
    const nums = s.line.map(valueOf);
    const order = direction ? revealOrder(s.line.length, direction) : [];
    const revealed = new Set(order.slice(0, count));
    const wrong = direction && ready ? liveWrong(nums, direction, count) : new Set();
    const done = direction && count >= s.line.length;
    const marks = done && ready ? lisMarks(nums) : null;
    const next = direction && !done ? order[count] : -1;
    inner = s.line.map((id, i) => {
      const cls = [
        wrong.has(i) ? 'wrong' : '',
        marks && marks[i] !== 'ok' ? `mark-${marks[i]}` : '',
        i === next && isHost() ? 'next' : '',
        revealed.has(i) && i === order[count - 1] && count > lastRevealCount ? 'flip-in' : '',
      ].join(' ');
      const card = cardHtml(s.cards[id], { faceUp: revealed.has(i), classes: cls });
      return i === next && isHost() ? `<div class="flip-target" data-action="flip">${card}</div>` : card;
    }).join('');
  }
  return `
    <div class="zone line-zone ${playing ? '' : 'locked'}" ${playing ? 'data-zone="line"' : ''}>
      <div class="zone-head">
        <span class="axis">1 小さい</span>
        <span class="zone-title">並べる列</span>
        <span class="axis">大きい 100</span>
      </div>
      <div class="card-row">${inner || '<p class="zone-empty">ここにカードを小さい順に並べます</p>'}</div>
    </div>`;
}

function stagingHtml() {
  const s = state;
  const cards = s.staging.map((id) => cardHtml(s.cards[id], { draggable: true })).join('');
  return `
    <div class="zone staging-zone" data-zone="staging">
      <div class="zone-head"><span class="zone-title">待機エリア</span><span class="hint">出されたカードはここに来ます。ドラッグして列に入れてください</span></div>
      <div class="card-row">${cards || '<p class="zone-empty">まだカードはありません</p>'}</div>
    </div>`;
}

function resultHtml() {
  const s = state;
  const { direction, count } = s.reveal;
  if (!direction || count < s.line.length || !valuesReady()) return '';
  const nums = s.line.map(valueOf);
  const ok = isSuccess(nums);
  const marks = lisMarks(nums);
  const sorted = [...s.line].sort((a, b) => valueOf(a) - valueOf(b));
  return `
    <div class="panel result ${ok ? 'success' : 'fail'}">
      <div class="result-title">${ok ? '🎉 成功！' : '😵 失敗…'}</div>
      ${ok ? '<p>すべて正しい順番に並んでいました。</p>' : `
        <ul class="legend">
          <li><span class="swatch wrong"></span>めくった時点で順番が逆だったカード</li>
          ${marks.includes('off') ? '<li><span class="swatch mark-off"></span>ずれていたカード（これだけ動かせば正しい並びになる）</li>' : ''}
          ${marks.includes('maybe') ? '<li><span class="swatch mark-maybe"></span>ずれていたかもしれないカード（どちらとも言えない）</li>' : ''}
        </ul>
        <div class="correct">
          <div class="correct-label">正しい並び</div>
          <div class="correct-row">${sorted.map((id) => `<span class="mini"><b>${valueOf(id)}</b>${esc(nameOf(s, s.cards[id].owner))}</span>`).join('')}</div>
        </div>`}
    </div>`;
}

// ---------- 操作エリア ----------

function controlsHtml() {
  const s = state;
  if (s.phase === 'lobby') return isHost() ? hostLobbyHtml() : '<div class="panel waiting">ホストがゲームを始めるのを待っています…</div>';
  if (s.phase === 'topic') return isHost() ? hostTopicHtml() : topicWaitingHtml();
  if (s.phase === 'playing') return `${handHtml()}${isHost() ? hostPlayingHtml() : ''}`;
  return isHost() ? hostRevealHtml() : `<div class="panel waiting">${revealStatus()}</div>`;
}

function hostLobbyHtml() {
  const s = state;
  const n = Object.keys(s.players).length;
  const reason = n < MIN_PLAYERS ? `${MIN_PLAYERS}人以上で始められます` : '';
  return `
    <div class="panel host-panel">
      <h3>ホストの設定</h3>
      <div class="settings">
        <label class="field">
          <span>1人あたりの枚数</span>
          <select data-change="per-player">
            ${[1, 2, 3].map((k) => `<option value="${k}" ${s.settings.perPlayer === k ? 'selected' : ''}>${k}枚</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="start-row">
        <button class="btn primary big" data-action="start" ${reason ? 'disabled' : ''}>ゲーム開始</button>
        <span class="hint">${reason || '押すとお題選びに進みます'}</span>
      </div>
    </div>`;
}

function hostTopicHtml() {
  const t = state.topic;
  const back = '<button class="btn ghost" data-action="back-to-genre">ジャンル選びに戻る</button>';
  const lobby = '<button class="btn ghost" data-action="abort">ロビーに戻る</button>';
  if (t.current) {
    return `
      <div class="panel host-panel row">
        <button class="btn primary big" data-action="begin-play" ${spinAnim ? 'disabled' : ''}>このお題で始める</button>
        ${t.step === 'choose' ? '<span class="hint">ジャンルを押すと回し直せます</span>' : back}
      </div>`;
  }
  if (t.step === 'input') {
    return `
      <div class="panel host-panel row">
        <button class="btn" data-action="close-input">締め切って投票へ</button>
        <span class="hint">全員が入力すると自動で投票に進みます</span>
        ${back}
      </div>`;
  }
  if (t.step === 'vote') {
    return `
      <div class="panel host-panel row">
        ${candidatesOf(state).length ? '<button class="btn" data-action="close-vote">締め切って決める</button>' : ''}
        ${back}
      </div>`;
  }
  return `<div class="panel host-panel row"><span class="hint">ジャンルを選んでください</span>${lobby}</div>`;
}

function topicWaitingHtml() {
  const t = state.topic;
  if (t.current) return '<div class="panel waiting">ホストがゲームを始めるのを待っています…</div>';
  if (t.step === 'choose') return '<div class="panel waiting">ホストがお題を選んでいます…</div>';
  return '';
}

function handHtml() {
  const s = state;
  const mine = Object.values(s.cards).filter((c) => c.owner === pid);
  if (mine.length === 0) return '<div class="panel waiting">観戦中です。次のゲームから参加できます。</div>';
  const unplayed = mine.filter((c) => !c.played).sort((a, b) => (valueOf(a.id) ?? 0) - (valueOf(b.id) ?? 0));
  if (unplayed.length === 0) return '<div class="panel waiting">手札をすべて出しました。みんなで並べ方を相談しましょう。</div>';
  return `
    <div class="panel hand">
      <h3>あなたの手札 <span class="hint">数字は自分にしか見えません。出したカードは戻せず、ひとことも変えられません</span></h3>
      <div class="hand-row">
        ${unplayed.map((c) => `
          <form class="hand-card" data-form="play" data-id="${c.id}">
            <div class="card face mine"><div class="card-num">${valueOf(c.id) ?? '…'}</div></div>
            <input data-keep="word-${c.id}" maxlength="40" placeholder="ひとこと" autocomplete="off" required>
            <button class="btn primary" type="submit">出す</button>
          </form>`).join('')}
      </div>
    </div>`;
}

function hostPlayingHtml() {
  const s = state;
  const allPlayed = Object.values(s.cards).every((c) => c.played);
  const ready = allPlayed && s.staging.length === 0 && s.line.length > 0;
  const reason = !allPlayed ? '全員がカードを出すと押せます' : s.staging.length > 0 ? '待機エリアのカードを列に入れると押せます' : '';
  return `
    <div class="panel host-panel row">
      <button class="btn primary big" data-action="to-reveal" ${ready ? '' : 'disabled'}>答え合わせへ</button>
      ${reason ? `<span class="hint">${reason}</span>` : '<span class="hint">押すと並びが確定し、動かせなくなります</span>'}
      <button class="btn ghost" data-action="abort">ゲームをやめてロビーへ</button>
    </div>`;
}

function hostRevealHtml() {
  const s = state;
  const { direction, count } = s.reveal;
  if (!direction) {
    return `
      <div class="panel host-panel row">
        <span>どちらからめくりますか？</span>
        <button class="btn primary" data-action="direction" data-dir="asc">下から（小さい方から）</button>
        <button class="btn primary" data-action="direction" data-dir="desc">上から（大きい方から）</button>
      </div>`;
  }
  if (count < s.line.length) {
    return `
      <div class="panel host-panel row">
        <button class="btn primary big" data-action="flip">めくる（${count}/${s.line.length}）</button>
        <span class="hint">光っているカードをクリックしてもめくれます</span>
      </div>`;
  }
  return `
    <div class="panel host-panel row">
      <button class="btn primary big" data-action="next-game">次のゲームへ</button>
    </div>`;
}

function revealStatus() {
  const { direction, count } = state.reveal;
  if (!direction) return 'ホストが答え合わせの準備をしています…';
  if (count < state.line.length) return `${direction === 'asc' ? '下' : '上'}からめくっています（${count}/${state.line.length}）`;
  return 'ホストが次のゲームを準備しています…';
}

// ---------- 履歴（ホストだけ） ----------

async function saveHistoryIfDone() {
  const s = state;
  if (!isHost() || s.phase !== 'reveal') return;
  const { direction, count } = s.reveal;
  if (!direction || count < s.line.length || s.savedRound === s.round || !valuesReady()) return;
  if (!account.isGoogle) return;
  const nums = s.line.map(valueOf);
  const marks = lisMarks(nums);
  const wrong = liveWrong(nums, direction, count);
  await update((st) => (st.savedRound === st.round ? undefined : { ...st, savedRound: st.round }));
  await history.add({
    id: randomId(),
    at: Date.now(),
    topic: s.topic.current,
    direction,
    success: isSuccess(nums),
    cards: s.line.map((id, i) => ({
      name: nameOf(s, s.cards[id].owner),
      word: s.cards[id].word,
      value: valueOf(id),
      wrong: wrong.has(i),
      mark: marks[i],
    })),
  });
}

async function renderHistoryModal() {
  const el = document.getElementById('modal');
  if (!historyOpen || !isHost()) {
    el.innerHTML = '';
    return;
  }
  if (!account.isGoogle) {
    el.innerHTML = `
      <div class="modal-back" data-action="close-history">
        <div class="modal">
          <div class="modal-head">
            <h3>ゲーム履歴</h3>
            <button class="btn ghost" data-action="close-history">閉じる</button>
          </div>
          <p>履歴を残すには、<b>部屋を作る前に</b>トップ画面で「Google でログイン」してください。</p>
          <p class="hint">部屋の途中でログインするとホストが入れ替わってしまうため、トップ画面でのみログインできます。</p>
        </div>
      </div>`;
    return;
  }
  const list = await history.list();
  const fmt = (t) => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="modal-back" data-action="close-history">
      <div class="modal">
        <div class="modal-head">
          <h3>ゲーム履歴</h3>
          <button class="btn ghost" data-action="close-history">閉じる</button>
        </div>
        <p class="hint">この履歴は Google でログインしたあなただけが見られます</p>
        ${list.length === 0 ? '<p>まだ履歴はありません</p>' : list.map((h) => `
          <div class="hist ${h.success ? 'success' : 'fail'}">
            <div class="hist-head">
              <span class="hist-result">${h.success ? '成功' : '失敗'}</span>
              <span class="hist-topic">${esc(h.topic)}</span>
              <span class="hist-date">${fmt(h.at)}・${h.direction === 'asc' ? '下から' : '上から'}</span>
            </div>
            <div class="hist-cards">${h.cards.map((c) => `
              <span class="mini ${c.wrong ? 'wrong' : ''} ${c.mark !== 'ok' ? `mark-${c.mark}` : ''}">
                <b>${c.value}</b>${esc(c.name)}<i>${esc(c.word)}</i>
              </span>`).join('')}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---------- 操作 ----------

const actions = {
  async 'copy-invite'() {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      toast('招待リンクをコピーしました');
    } catch {
      window.prompt('このリンクを友達に送ってください', inviteUrl());
    }
  },

  'remove-player'(el) {
    update((s) => {
      delete s.players[el.dataset.id];
      delete s.topic.submissions[el.dataset.id];
      delete s.topic.votes[el.dataset.id];
      return advanceTopic(s);
    });
  },

  start() {
    update((s) => {
      if (s.phase !== 'lobby' || Object.keys(s.players).length < MIN_PLAYERS) return undefined;
      s.phase = 'topic';
      s.topic = newTopic();
      return s;
    });
  },

  // ジャンルのボックスを押す。自由入力なら入力画面へ、それ以外はルーレットを回す
  'choose-genre'(el) {
    const genre = el.dataset.id;
    if (genre === FREE_ID) {
      update((s) => {
        s.topic = { ...newTopic(), step: 'input', genre };
        return s;
      });
      return;
    }
    const list = topicsFor(genre);
    if (list.length === 0) return;
    const options = list.length > 1 ? list.filter((t) => t !== state.topic.current) : list;
    const pick = options[Math.floor(Math.random() * options.length)];
    update((s) => {
      s.topic = { ...newTopic(), genre, current: pick, spin: spinTopic(list, pick) };
      return s;
    });
  },

  omakase() {
    submitTopic('');
  },

  'redo-topic'() {
    update((s) => {
      if (s.topic.step !== 'input') return undefined;
      delete s.topic.submissions[pid];
      return s;
    });
  },

  'close-input'() {
    update((s) => {
      if (s.topic.step !== 'input') return undefined;
      s.topic.step = 'vote';
      return s;
    });
  },

  vote(el) {
    update((s) => {
      if (s.topic.step !== 'vote' || s.topic.current) return undefined;
      s.topic.votes[pid] = el.dataset.id;
      return advanceTopic(s);
    });
  },

  'close-vote'() {
    update((s) => {
      if (s.topic.step !== 'vote' || s.topic.current) return undefined;
      return decideByVote(s);
    });
  },

  'back-to-genre'() {
    update((s) => {
      s.topic = newTopic();
      return s;
    });
  },

  async 'begin-play'() {
    const ids = playersOf(state).map((p) => p.id);
    if (ids.length < MIN_PLAYERS || !state.topic.current) return;
    // 数字（本人しか読めない場所）を先に書いてから、ゲームを始める
    const { cards, hands, values: allValues } = deal(ids, state.settings.perPlayer);
    await store.deal(roomId, hands, allValues);
    update((s) => {
      if (s.phase !== 'topic' || !s.topic.current) return undefined;
      s.cards = cards;
      s.line = [];
      s.staging = [];
      s.reveal = null;
      s.round += 1;
      s.phase = 'playing';
      return s;
    });
  },

  'to-reveal'() {
    update((s) => {
      const allPlayed = Object.values(s.cards).every((c) => c.played);
      if (s.phase !== 'playing' || !allPlayed || s.staging.length > 0 || s.line.length === 0) return undefined;
      s.phase = 'reveal';
      s.reveal = { direction: null, count: 0 };
      return s;
    });
  },

  direction(el) {
    update((s) => {
      if (s.phase !== 'reveal' || s.reveal.direction) return undefined;
      s.reveal.direction = el.dataset.dir;
      return s;
    });
  },

  flip() {
    update((s) => {
      if (s.phase !== 'reveal' || !s.reveal.direction || s.reveal.count >= s.line.length) return undefined;
      s.reveal.count += 1;
      return s;
    });
  },

  async 'next-game'() {
    await update(backToLobby);
    store.clearDeal(roomId);
  },

  async abort() {
    if (state.phase !== 'topic' && !window.confirm('ゲームをやめてロビーに戻りますか？（配った数字はリセットされます）')) return;
    await update(backToLobby);
    store.clearDeal(roomId);
  },

  'open-history'() {
    historyOpen = true;
    renderHistoryModal();
  },

  'close-history'() {
    historyOpen = false;
    renderHistoryModal();
  },
};

function backToLobby(s) {
  s.phase = 'lobby';
  s.cards = {};
  s.line = [];
  s.staging = [];
  s.reveal = null;
  s.topic = newTopic();
  return s;
}

// 全員がお題を入力したら投票へ、全員が投票したら集計へ自動で進む
function advanceTopic(s) {
  if (s.phase !== 'topic') return s;
  const ids = Object.keys(s.players);
  if (s.topic.step === 'input' && ids.every((id) => id in s.topic.submissions)) {
    s.topic.step = 'vote';
  }
  if (s.topic.step === 'vote' && !s.topic.current && candidatesOf(s).length > 0
      && ids.every((id) => id in s.topic.votes)) {
    decideByVote(s);
  }
  return s;
}

function submitTopic(text) {
  update((s) => {
    if (s.phase !== 'topic' || s.topic.step !== 'input') return undefined;
    s.topic.submissions[pid] = text;
    return advanceTopic(s);
  });
}

const forms = {
  'submit-topic'(form) {
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    submitTopic(text);
  },

  play(form) {
    const id = form.dataset.id;
    const input = form.querySelector('input');
    const word = input.value.trim();
    if (!word) return;
    update((s) => {
      const card = s.cards[id];
      if (s.phase !== 'playing' || !card || card.owner !== pid || card.played) return undefined;
      card.played = true;
      card.word = word;
      s.staging.push(id);
      return s;
    });
  },
};

const changes = {
  'per-player'(el) {
    update((s) => {
      s.settings.perPlayer = Number(el.value);
      return s;
    });
  },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // モーダルの外側（暗い部分）をクリックしたときだけ閉じる
  if (el.classList.contains('modal-back') && e.target !== el) return;
  actions[el.dataset.action]?.(el);
});

app.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(form);
});

app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el);
});

// 日本語入力の変換中に画面を書き換えると入力が途切れるので、変換が終わるまで待つ
document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', () => {
  composing = false;
  if (renderQueued) requestRender();
});

setupDrag({
  onDragChange(on) {
    dragging = on;
    if (!on && renderQueued) requestRender();
  },
  onDrop(id, zone, index) {
    update((s) => {
      if (s.phase !== 'playing' || !s.cards[id]?.played) return undefined;
      s.line = s.line.filter((x) => x !== id);
      s.staging = s.staging.filter((x) => x !== id);
      if (zone === 'line') s.line.splice(Math.min(index, s.line.length), 0, id);
      else s.staging.push(id);
      return s;
    });
  },
});

// ---------- 起動 ----------

(async function init() {
  app.innerHTML = '<main class="entry"><p class="hint">接続しています…</p></main>';
  try {
    pid = (await account.ready()).uid;
  } catch (err) {
    renderMessage('接続できませんでした', `通信状態を確認して、ページを再読み込みしてください（${err.code ?? err.message}）`);
    return;
  }
  if (!roomId) {
    renderEntry({ mode: 'create' });
    return;
  }
  const room = await store.get(roomId);
  if (!room) {
    renderMessage('部屋が見つかりません', `部屋 ${roomId} は存在しないか、なくなったようです。`, { label: '新しく部屋を作る', onClick: goHome });
    return;
  }
  if (room.players[pid]) enterRoom();
  else renderEntry({ mode: 'join' });
})();
