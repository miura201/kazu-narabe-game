// 部屋の状態と履歴の保存先。
// いまは同じPCのブラウザ内（localStorage）だけで共有する「ローカル版」。
// あとで Firebase 版に差し替えるときは、同じ形（get / create / update / subscribe、
// history.add / history.list）を持つオブジェクトを書けば app.js は変更不要。

const ROOM_KEY = (id) => `knr:room:${id}`;
const HISTORY_KEY = 'knr:history';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('knr') : null;
const listeners = new Map(); // roomId -> Set<callback>

function read(id) {
  try {
    const raw = localStorage.getItem(ROOM_KEY(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(id, state) {
  localStorage.setItem(ROOM_KEY(id), JSON.stringify(state));
  notify(id);
  channel?.postMessage({ roomId: id });
}

function notify(id) {
  const state = read(id);
  listeners.get(id)?.forEach((cb) => cb(state));
}

channel?.addEventListener('message', (e) => notify(e.data.roomId));
window.addEventListener('storage', (e) => {
  if (e.key?.startsWith('knr:room:')) notify(e.key.slice('knr:room:'.length));
});

export const store = {
  async get(id) {
    return read(id);
  },

  async create(id, state) {
    if (read(id)) throw new Error('room exists');
    write(id, state);
  },

  // fn は状態のコピーを受け取り、書き換えて返す。undefined を返すと何もしない。
  async update(id, fn) {
    const current = read(id);
    if (!current) return null;
    const next = fn(structuredClone(current));
    if (next === undefined) return current;
    write(id, next);
    return next;
  },

  subscribe(id, cb) {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(cb);
    cb(read(id));
    return () => listeners.get(id)?.delete(cb);
  },
};

// ゲーム履歴。ローカル版はこのブラウザにだけ保存する。
// Firebase 版ではホストの Google アカウントにひもづけて保存する予定。
export const history = {
  async add(entry) {
    const list = await this.list();
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 200)));
  },

  async list() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
    } catch {
      return [];
    }
  },
};
