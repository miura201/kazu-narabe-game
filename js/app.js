import { store, history } from './store.js';
import {
  MAX_PLAYERS, MIN_PLAYERS, randomRoomId, randomId, shuffle, deal,
  revealOrder, liveWrong, lisMarks, isSuccess,
} from './logic.js';
import { TOPIC_MODES, FREE_ID, RANDOM_ID, topicsFor } from './topics.js';
import { setupDrag } from './drag.js';

const GAME_TITLE = 'かずならべ';
const SPIN_FRESH_MS = 4000; // これより古いルーレットは、あとから入った人には演出せず結果だけ見せる

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
let roomId = params.get('room')?.toUpperCase() ?? null;

// プレイヤーIDはタブごと（sessionStorage）。同じPCで複数タブを開けば別の人として遊べる。
const pid = sessionStorage.getItem('knr:pid') ?? randomId();
sessionStorage.setItem('knr:pid', pid);

let state = null;
let unsubscribe = null;
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
    </main>`;
  const input = document.getElementById('name-input');
  input.focus();
  document.getElementById('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    localStorage.setItem('knr:lastName', name);
    if (mode === 'join') await joinRoom(name);
    else await createRoom(name);
  });
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
    createdAt: Date.now(),
    players: { [pid]: { name, joinedAt: Date.now() } },
    phase: 'lobby', // lobby → playing → reveal → lobby …
    settings: { perPlayer: 1, topicMode: RANDOM_ID },
    topic: { current: null, by: null, candidates: {}, spin: null },
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
  await update((s) => {
    if (s.players[pid]) return s;
    if (Object.keys(s.players).length >= MAX_PLAYERS) {
      error = `この部屋は満員です（最大${MAX_PLAYERS}人）`;
      return undefined;
    }
    s.players[pid] = { name, joinedAt: Date.now() };
    return s;
  });
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

  startSpinIfNew();
  document.getElementById('history-btn').hidden = !isHost();
  patch(document.getElementById('players'), playersHtml());
  patch(document.getElementById('topic'), topicHtml());
  patch(document.getElementById('stage'), stageHtml());
  patch(document.getElementById('controls'), controlsHtml());
  if (historyOpen && !isHost()) actions['close-history']();
  saveHistoryIfDone();
  if (state.phase !== 'reveal') lastRevealCount = 0;
  else lastRevealCount = state.reveal?.count ?? 0;
}

function goHome() {
  unsubscribe?.();
  roomId = null;
  window.history.replaceState(null, '', location.pathname);
  renderEntry({ mode: 'create' });
}

// ---------- 参加者 ----------

function playersHtml() {
  const s = state;
  const inGame = s.phase !== 'lobby';
  return playersOf(s).map((p) => {
    const hand = Object.values(s.cards).filter((c) => c.owner === p.id);
    const left = hand.filter((c) => !c.played).length;
    const status = !inGame ? '' : hand.length === 0 ? '<span class="chip-sub">観戦</span>'
      : left > 0 ? `<span class="chip-sub">手札${left}枚</span>` : '<span class="chip-sub done">出しきり</span>';
    const remove = isHost() && s.phase === 'lobby' && p.id !== pid
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
    return `<div class="topic-label">お題</div><div class="topic-text empty">${isHost() ? 'お題を決めてください' : 'ホストがお題を決めています'}</div>`;
  }
  const by = t.by ? `<div class="topic-by">${esc(nameOf(state, t.by))} さんの案</div>` : '';
  return `<div class="topic-label">お題</div><div class="topic-text">${esc(t.current)}</div>${by}`;
}

function startSpinIfNew() {
  const spin = state.topic.spin;
  if (!spin || spin.id === lastSpinId) return;
  lastSpinId = spin.id;
  if (Date.now() - spin.at > SPIN_FRESH_MS) return;
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
  return { id: randomId(), at: Date.now(), items, result: pick };
}

// ---------- メインエリア ----------

function stageHtml() {
  const s = state;
  if (s.phase === 'lobby') return lobbyStageHtml();
  return `${lineHtml()}${s.phase === 'playing' ? stagingHtml() : resultHtml()}`;
}

function lobbyStageHtml() {
  const s = state;
  const parts = [];
  if (s.settings.topicMode === FREE_ID) parts.push(candidatesHtml());
  parts.push(`
    <div class="panel howto">
      <h3>遊び方</h3>
      <ol>
        <li>ホストが枚数とお題を決めて、ゲームを始めます。</li>
        <li>配られた数字（1〜100）を、お題に沿った「ひとこと」で表現してカードを出します。</li>
        <li>出されたカードは待機エリアに置かれます。みんなで相談して、小さい順になるよう列に並べます。</li>
        <li>並びが決まったら、ホストが答え合わせをして1枚ずつめくります。</li>
      </ol>
      ${Object.keys(s.players).length < MIN_PLAYERS ? `<p class="hint">「招待リンクをコピー」で友達を呼びましょう（${MIN_PLAYERS}人から遊べます）</p>` : ''}
    </div>`);
  return parts.join('');
}

function candidatesHtml() {
  const s = state;
  const list = Object.entries(s.topic.candidates);
  const mine = s.topic.candidates[pid];
  const items = list.length === 0
    ? '<p class="hint">まだお題の案がありません</p>'
    : `<ul class="cand-list">${list.map(([owner, text]) => `
        <li class="${s.topic.current === text ? 'chosen' : ''}">
          <span class="cand-text">${esc(text)}</span>
          <span class="cand-by">${esc(nameOf(s, owner))}</span>
          ${isHost() ? `<button class="btn small" data-action="pick-candidate" data-id="${owner}">これにする</button>` : ''}
        </li>`).join('')}</ul>`;
  return `
    <div class="panel">
      <h3>みんなのお題案</h3>
      <form class="inline-form" data-form="propose">
        <input data-keep="cand" maxlength="40" placeholder="お題を思いついたら入力（出さなくてもOK）" autocomplete="off">
        <button class="btn" type="submit">${mine ? '変更する' : '出す'}</button>
        ${mine ? '<button class="btn ghost" type="button" data-action="withdraw">取り下げる</button>' : ''}
      </form>
      ${items}
      ${isHost() && list.length > 0 ? '<button class="btn" data-action="random-candidate">ランダムで決める</button>' : ''}
    </div>`;
}

function cardHtml(card, { faceUp = false, draggable = false, classes = '' } = {}) {
  return `
    <div class="card ${faceUp ? 'face' : 'back'} ${classes}" data-card="${card.id}" ${draggable ? `data-drag="${card.id}"` : ''} title="${esc(nameOf(state, card.owner))}：${esc(card.word)}">
      <div class="card-owner">${esc(nameOf(state, card.owner))}</div>
      ${faceUp ? `<div class="card-num">${card.value}</div>` : '<div class="card-mark">?</div>'}
      <div class="card-word">${esc(card.word)}</div>
    </div>`;
}

function lineHtml() {
  const s = state;
  const playing = s.phase === 'playing';
  const values = s.line.map((id) => s.cards[id].value);
  let inner;
  if (playing) {
    inner = s.line.map((id) => cardHtml(s.cards[id], { draggable: true })).join('');
  } else {
    const { direction, count } = s.reveal;
    const order = direction ? revealOrder(s.line.length, direction) : [];
    const revealed = new Set(order.slice(0, count));
    const wrong = direction ? liveWrong(values, direction, count) : new Set();
    const done = direction && count >= s.line.length;
    const marks = done ? lisMarks(values) : null;
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
  if (!direction || count < s.line.length) return '';
  const values = s.line.map((id) => s.cards[id].value);
  const ok = isSuccess(values);
  const marks = lisMarks(values);
  const sorted = [...s.line].sort((a, b) => s.cards[a].value - s.cards[b].value);
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
          <div class="correct-row">${sorted.map((id) => `<span class="mini"><b>${s.cards[id].value}</b>${esc(nameOf(s, s.cards[id].owner))}</span>`).join('')}</div>
        </div>`}
    </div>`;
}

// ---------- 操作エリア ----------

function controlsHtml() {
  const s = state;
  if (s.phase === 'lobby') return isHost() ? hostLobbyHtml() : '<div class="panel waiting">ホストの準備を待っています…</div>';
  if (s.phase === 'playing') return `${handHtml()}${isHost() ? hostPlayingHtml() : ''}`;
  return isHost() ? hostRevealHtml() : `<div class="panel waiting">${revealStatus()}</div>`;
}

function hostLobbyHtml() {
  const s = state;
  const n = Object.keys(s.players).length;
  const free = s.settings.topicMode === FREE_ID;
  let reason = '';
  if (n < MIN_PLAYERS) reason = `${MIN_PLAYERS}人以上で始められます`;
  else if (!s.topic.current) reason = 'お題を決めてください';
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
        <label class="field">
          <span>お題の決め方</span>
          <select data-change="topic-mode">
            ${TOPIC_MODES.map((m) => `<option value="${m.id}" ${s.settings.topicMode === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
          </select>
        </label>
        ${free ? '<p class="hint">みんなのお題案から「これにする」で選びます</p>'
          : `<button class="btn" data-action="spin">🎲 ${s.topic.current ? 'ルーレットを回し直す' : 'ルーレットを回す'}</button>`}
      </div>
      <div class="start-row">
        <button class="btn primary big" data-action="start" ${reason ? 'disabled' : ''}>ゲーム開始</button>
        ${reason ? `<span class="hint">${reason}</span>` : ''}
      </div>
    </div>`;
}

function handHtml() {
  const s = state;
  const mine = Object.values(s.cards).filter((c) => c.owner === pid);
  if (mine.length === 0) return '<div class="panel waiting">観戦中です。次のゲームから参加できます。</div>';
  const unplayed = mine.filter((c) => !c.played).sort((a, b) => a.value - b.value);
  if (unplayed.length === 0) return '<div class="panel waiting">手札をすべて出しました。みんなで並べ方を相談しましょう。</div>';
  return `
    <div class="panel hand">
      <h3>あなたの手札 <span class="hint">数字は自分にしか見えません。出したカードは戻せず、ひとことも変えられません</span></h3>
      <div class="hand-row">
        ${unplayed.map((c) => `
          <form class="hand-card" data-form="play" data-id="${c.id}">
            <div class="card face mine"><div class="card-num">${c.value}</div></div>
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
  if (!direction || count < s.line.length || s.savedRound === s.round) return;
  const values = s.line.map((id) => s.cards[id].value);
  const marks = lisMarks(values);
  const wrong = liveWrong(values, direction, count);
  await update((st) => (st.savedRound === st.round ? undefined : { ...st, savedRound: st.round }));
  await history.add({
    id: randomId(),
    at: Date.now(),
    topic: s.topic.current,
    direction,
    success: isSuccess(values),
    cards: s.line.map((id, i) => ({
      name: nameOf(s, s.cards[id].owner),
      word: s.cards[id].word,
      value: s.cards[id].value,
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
  const list = await history.list();
  const fmt = (t) => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="modal-back" data-action="close-history">
      <div class="modal">
        <div class="modal-head">
          <h3>ゲーム履歴</h3>
          <button class="btn ghost" data-action="close-history">閉じる</button>
        </div>
        <p class="hint">この履歴はホストのあなただけが見られます（いまはこのブラウザに保存）</p>
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
      delete s.topic.candidates[el.dataset.id];
      return s;
    });
  },

  spin() {
    const list = topicsFor(state.settings.topicMode);
    if (list.length === 0) return;
    const options = list.length > 1 ? list.filter((t) => t !== state.topic.current) : list;
    const pick = options[Math.floor(Math.random() * options.length)];
    update((s) => {
      s.topic = { ...s.topic, current: pick, by: null, spin: spinTopic(list, pick) };
      return s;
    });
  },

  withdraw() {
    update((s) => {
      delete s.topic.candidates[pid];
      return s;
    });
  },

  'pick-candidate'(el) {
    update((s) => {
      const text = s.topic.candidates[el.dataset.id];
      if (!text) return undefined;
      s.topic = { ...s.topic, current: text, by: el.dataset.id, spin: null };
      return s;
    });
  },

  'random-candidate'() {
    const entries = Object.entries(state.topic.candidates);
    if (entries.length === 0) return;
    const [owner, text] = entries[Math.floor(Math.random() * entries.length)];
    update((s) => {
      s.topic = { ...s.topic, current: text, by: owner, spin: spinTopic(entries.map((e) => e[1]), text) };
      return s;
    });
  },

  start() {
    update((s) => {
      const ids = playersOf(s).map((p) => p.id);
      if (ids.length < MIN_PLAYERS || !s.topic.current) return undefined;
      s.cards = deal(ids, s.settings.perPlayer);
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

  'next-game'() {
    update((s) => backToLobby(s, { keepTopic: false }));
  },

  abort() {
    if (!window.confirm('ゲームをやめてロビーに戻りますか？（配った数字はリセットされます）')) return;
    update((s) => backToLobby(s, { keepTopic: true }));
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

function backToLobby(s, { keepTopic }) {
  s.phase = 'lobby';
  s.cards = {};
  s.line = [];
  s.staging = [];
  s.reveal = null;
  if (!keepTopic) s.topic = { current: null, by: null, candidates: {}, spin: null };
  return s;
}

const forms = {
  propose(form) {
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    update((s) => {
      s.topic.candidates[pid] = text;
      return s;
    });
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

  'topic-mode'(el) {
    update((s) => {
      s.settings.topicMode = el.value;
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
