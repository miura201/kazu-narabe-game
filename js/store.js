// 部屋の状態・手札・履歴の保存先（Firebase Realtime Database）とログイン（Firebase Authentication）。
//
// データの置き場所:
//   rooms/{部屋}/state         … 全員が見られる部屋の状態（数字は入っていない）
//   rooms/{部屋}/hands/{uid}   … その人の手札の数字。本人しか読めない
//   rooms/{部屋}/values        … 全カードの数字。答え合わせ中だけ全員が読める
//   users/{uid}/history        … ゲーム履歴。本人（Google ログインしたホスト）しか読めない

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js';
import {
  initializeAuth, browserLocalPersistence, browserSessionPersistence, browserPopupRedirectResolver,
  signInAnonymously, signInWithPopup, signOut, GoogleAuthProvider, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, update as dbUpdate, push, onValue, onDisconnect, runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ログイン状態はブラウザに保存する。タブを閉じたりスマホでページが消えたりしても、
// 同じブラウザで開き直せば同じ参加者として戻れる。
// ローカル確認（localhost）のときだけはタブごとに別の参加者にして、1台で複数人の動きを試せるようにする。
const isLocalDev = location.hostname === 'localhost';
const auth = initializeAuth(app, {
  persistence: isLocalDev ? browserSessionPersistence : browserLocalPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

let serverOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => { serverOffset = snap.val() ?? 0; });

// Realtime Database は空の配列やオブジェクトを保存しないので、読み込み時に形をそろえる
function toArray(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  return v ? Object.values(v) : [];
}

function normalize(s) {
  if (!s) return null;
  s.players ??= {};
  s.cards ??= {};
  s.line = toArray(s.line);
  s.staging = toArray(s.staging);
  s.topic ??= {};
  s.topic.current ??= null;
  s.topic.by ??= null;
  s.topic.step ??= 'choose';
  s.topic.genre ??= null;
  s.topic.submissions ??= {};
  s.topic.votes ??= {};
  s.topic.tally ??= null;
  s.topic.spin ??= null;
  if (s.topic.spin) s.topic.spin.items = toArray(s.topic.spin.items);
  s.reveal ??= null;
  return s;
}

// undefined を含むと保存できないので取り除く
const clean = (v) => JSON.parse(JSON.stringify(v));

const roomRef = (id, path = 'state') => ref(db, `rooms/${id}/${path}`);

export const store = {
  // サーバーの時計に合わせた現在時刻（ルーレット演出のタイミング合わせ用）
  now: () => Date.now() + serverOffset,

  async get(id) {
    const snap = await get(roomRef(id));
    return normalize(snap.val());
  },

  async create(id, state) {
    await runTransaction(roomRef(id), (current) => (current ? undefined : clean(state)));
  },

  // fn は状態のコピーを受け取り、書き換えて返す。undefined を返すと何もしない。
  // 同時に複数人が操作しても壊れないよう、トランザクションで書き込む。
  async update(id, fn) {
    const result = await runTransaction(roomRef(id), (current) => {
      // まだ手元にデータがないときは一度 null で呼ばれる。そのまま返すとサーバーの値で再実行される
      if (current === null) return null;
      const next = fn(normalize(current));
      return next === undefined ? undefined : clean(next);
    });
    return normalize(result.snapshot.val());
  },

  subscribe(id, cb) {
    return onValue(roomRef(id), (snap) => cb(normalize(snap.val())));
  },

  // 配る（ホストだけが書ける）。hands は { uid: { カードID: 数字 } }、values は { カードID: 数字 }
  async deal(id, hands, values) {
    await dbUpdate(ref(db, `rooms/${id}`), { hands, values });
  },

  async clearDeal(id) {
    await dbUpdate(ref(db, `rooms/${id}`), { hands: null, values: null });
  },

  subscribeHand(id, uid, cb) {
    return onValue(roomRef(id, `hands/${uid}`), (snap) => cb(snap.val() ?? {}), () => cb({}));
  },

  // 答え合わせ中だけ読める。それ以外のときは onError が呼ばれる
  subscribeValues(id, cb, onError) {
    return onValue(roomRef(id, 'values'), (snap) => cb(snap.val() ?? {}), onError);
  },

  // 自分がオンラインであることを知らせる。通信が切れたら Firebase が自動で消してくれる
  announcePresence(id, uid) {
    const mine = roomRef(id, `presence/${uid}`);
    return onValue(ref(db, '.info/connected'), async (snap) => {
      if (snap.val() !== true) return;
      try {
        await onDisconnect(mine).remove();
        await set(mine, true);
      } catch (err) {
        console.warn('オンライン表示を書き込めませんでした（セキュリティルールを確認）', err);
      }
    });
  },

  // 読めないとき（ルール未設定など）は null のまま＝全員オンライン扱いにする
  subscribePresence(id, cb) {
    return onValue(roomRef(id, 'presence'), (snap) => cb(snap.val() ?? {}), () => cb(null));
  },
};

export const account = {
  // ログイン状態が分かるまで待ち、誰もログインしていなければ匿名でログインする
  async ready() {
    await auth.authStateReady();
    if (!auth.currentUser) await signInAnonymously(auth);
    return auth.currentUser;
  },

  get user() {
    return auth.currentUser;
  },

  get isGoogle() {
    return !!auth.currentUser && !auth.currentUser.isAnonymous;
  },

  async loginWithGoogle() {
    await signInWithPopup(auth, new GoogleAuthProvider());
  },

  async logout() {
    await signOut(auth);
    await signInAnonymously(auth);
  },

  onChange(cb) {
    return onAuthStateChanged(auth, cb);
  },
};

// ゲーム履歴。Google でログインしたホストだけが保存・閲覧できる。
export const history = {
  async add(entry) {
    if (!account.isGoogle) return;
    await push(ref(db, `users/${auth.currentUser.uid}/history`), clean(entry));
  },

  async list() {
    if (!account.isGoogle) return [];
    const snap = await get(ref(db, `users/${auth.currentUser.uid}/history`));
    return Object.values(snap.val() ?? {}).sort((a, b) => b.at - a.at);
  },
};
