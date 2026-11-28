// ゲームのルールに関わる計算（画面には依存しない）

export const MAX_PLAYERS = 15;
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

// 1〜100 から重複なしで、各プレイヤーに perPlayer 枚ずつ配る。
// cards は全員に見える情報（数字なし）、hands は人ごとの数字、values は全カードの数字。
export function deal(playerIds, perPlayer) {
  const numbers = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  const cards = {};
  const hands = {};
  const values = {};
  let k = 0;
  for (const owner of playerIds) {
    hands[owner] = {};
    for (const value of numbers.slice(k, k + perPlayer)) {
      const id = randomId();
      cards[id] = { id, owner, word: '', played: false };
      hands[owner][id] = value;
      values[id] = value;
    }
    k += perPlayer;
  }
  return { cards, hands, values };
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

// 全部めくったあとの振り返り用。各カードが本当の位置からいくつずれていたか。
//   0 … 正しい位置 ／ +3 … 本当はあと3つ右（もっと大きい） ／ -1 … 本当はあと1つ左（もっと小さい）
export function positionShifts(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v, i) => sorted.indexOf(v) - i);
}

export function shiftLabel(shift) {
  if (shift === 0) return '✓';
  return shift > 0 ? `→${shift}` : `←${-shift}`;
}

export function isSuccess(values) {
  return values.every((v, i) => i === 0 || values[i - 1] < v);
}

// ---------- Tier表作成 ----------

// 予想した1つの点数。answer は並べる人の答え（1位から順）、index はその予想を何位に置いたか（0 始まり）
//   ◎ 順位までぴったり 3点 ／ ○ 1つずれ 2点 ／ △ 答えに入っているが2つ以上ずれ 1点 ／ × 入っていない 0点
export function tierMark(answer, item, index) {
  const at = answer.indexOf(item);
  if (at < 0) return { mark: '×', points: 0 };
  const d = Math.abs(at - index);
  if (d === 0) return { mark: '◎', points: 3 };
  if (d === 1) return { mark: '○', points: 2 };
  return { mark: '△', points: 1 };
}

export function tierScore(answer, guess) {
  return guess.reduce((sum, item, i) => sum + tierMark(answer, item, i).points, 0);
}

// 相性診断：2人の順位がどれだけ近いか。点数の付け方は予想と同じで、どちらから見ても同じ点数になる
export function matchScore(a, b) {
  return tierScore(a, b);
}

// 2人組のキー（順番によらず同じになる）
export const pairKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
