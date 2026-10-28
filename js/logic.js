// ゲームのルールに関わる計算（画面には依存しない）

export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomRoomId() {
  let id = '';
  for (let i = 0; i < 4; i++) id += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return id;
}

export function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 1〜100 から重複なしで、各プレイヤーに perPlayer 枚ずつ配る
export function deal(playerIds, perPlayer) {
  const numbers = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  const cards = {};
  let k = 0;
  for (const owner of playerIds) {
    const values = numbers.slice(k, k + perPlayer).sort((a, b) => a - b);
    k += perPlayer;
    for (const value of values) {
      const id = randomId();
      cards[id] = { id, owner, value, word: '', played: false };
    }
  }
  return cards;
}

// めくる順番（列の位置の並び）。asc は左（小）から、desc は右（大）から。
export function revealOrder(length, direction) {
  const idx = Array.from({ length }, (_, i) => i);
  return direction === 'desc' ? idx.reverse() : idx;
}

// めくっている最中の「赤」判定。
// 下から：それまでにめくった最大値より小さい数が出たら赤。
// 上から：それまでにめくった最小値より大きい数が出たら赤。
export function liveWrong(values, direction, revealedCount) {
  const wrong = new Set();
  const order = revealOrder(values.length, direction).slice(0, revealedCount);
  let edge = null;
  for (const i of order) {
    const v = values[i];
    if (edge === null) {
      edge = v;
    } else if (direction === 'desc' ? v > edge : v < edge) {
      wrong.add(i);
    } else {
      edge = v;
    }
  }
  return wrong;
}

// 全部めくったあとの振り返り用の印。
// 「最小限のカードだけ動かせば正しい並びになる」＝最長増加部分列（LIS）に入らないカードを探す。
//   'ok'    … どの最長の並びにも必ず含まれる（正しい位置）
//   'off'   … どの最長の並びにも含まれない（ずれていたカード）
//   'maybe' … 含まれる並びと含まれない並びがある（どちらとも言えない）
export function lisMarks(values) {
  const n = values.length;
  const L = new Array(n).fill(1);
  const R = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i]) L[i] = Math.max(L[i], L[j] + 1);
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) {
      if (values[j] > values[i]) R[i] = Math.max(R[i], R[j] + 1);
    }
  }
  const best = Math.max(0, ...L);
  const inSome = L.map((l, i) => l + R[i] - 1 === best);
  // LIS の中で k 番目に来られるカードが1枚だけなら、そのカードはすべての LIS に含まれる
  const countAtLevel = new Map();
  inSome.forEach((ok, i) => {
    if (ok) countAtLevel.set(L[i], (countAtLevel.get(L[i]) ?? 0) + 1);
  });
  return values.map((_, i) => {
    if (!inSome[i]) return 'off';
    return countAtLevel.get(L[i]) === 1 ? 'ok' : 'maybe';
  });
}

export function isSuccess(values) {
  return values.every((v, i) => i === 0 || values[i - 1] < v);
}
