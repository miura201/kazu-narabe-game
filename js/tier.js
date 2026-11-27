// Tier表作成ゲーム。
// 流れ：選択肢を集める（options）→ 並べる人が順位をつける（ranking）→ ほかの人が予想する（predict）→ 答え合わせ（reveal）
// 並べる人の答えと各自の予想は、答え合わせまで本人しか読めない場所に保存する（store.js / database.rules.json）。

import { randomId, tierMark, tierScore } from './logic.js';
import { tierOptionsFor } from './tier-topics.js';

const ADD_LIMIT_PRESET = 2; // 用意した選択肢があるお題で、1人が追加できる数（並べる人は無制限）
const ADD_LIMIT_FREE = 5; // 自由入力のお題で、1人が追加できる数
// 選択肢の数で難しさが変わらないよう、毎回ちょうどこの数から選ぶ。足したいときは枠を空けて入れ替える
const OPTION_COUNT = 10;

// お題が決まったら Tier表のゲームを始める。お題番がそのまま並べる人になる
export function startTier(s) {
  const options = {};
  tierOptionsFor(s.topic.current).forEach((text, i) => {
    options[randomId()] = { text, by: null, at: i };
  });
  s.phase = 'tier';
  s.round += 1;
  s.tier = {
    ranker: s.topic.chooser ?? s.hostId,
    free: Object.keys(options).length === 0,
    size: s.settings.tierCount,
    step: 'options',
    options,
    predictors: [],
    submitted: {},
    count: 0, // 答え合わせでめくった数（下の順位から）
    result: null,
  };
  return s;
}

// 全員が予想を出したら答え合わせへ進む
function advance(s) {
  const t = s.tier;
  if (t.step === 'predict' && t.predictors.every((id) => t.submitted[id])) {
    t.step = 'reveal';
    t.count = 0;
  }
  return s;
}

// 部屋から人が抜けたとき。並べる人が抜けたら続けられないので false を返す（ロビーに戻す）
export function tierRemovePlayer(s, id) {
  if (s.phase !== 'tier' || !s.tier) return true;
  if (s.tier.ranker === id) return false;
  s.tier.predictors = s.tier.predictors.filter((x) => x !== id);
  delete s.tier.submitted[id];
  advance(s);
  return true;
}

export function createTier(ctx) {
  const { esc } = ctx;
  const S = () => ctx.state();
  const T = () => S().tier;
  const me = () => ctx.pid();
  const isRanker = () => T()?.ranker === me();
  const who = (id) => (id === me() ? 'あなた' : `${esc(ctx.nameOf(S(), id))} さん`);

  // 自分が組み立て中の順位（まだ保存していない）。ゲームと役割が変わったら作り直す
  let draft = { key: null, order: [] };
  function myDraft() {
    const key = `${S().round}:${isRanker() ? 'answer' : 'guess'}`;
    if (draft.key !== key) draft = { key, order: [] };
    draft.order = draft.order.filter((id) => T().options[id]);
    return draft;
  }

  const optionList = () => Object.entries(T().options)
    .map(([id, o]) => ({ id, ...o }))
    .sort((a, b) => a.at - b.at);
  const textOf = (id) => T().options[id]?.text ?? '（消えた選択肢）';

  // ---------- 答え合わせのデータ ----------

  let answer = null;
  let guesses = {};
  let guessesLoaded = false;
  let unsubAnswer = null;
  let unsubGuesses = null;

  function sync() {
    const s = S();
    if (s.phase === 'tier' && s.tier?.step === 'reveal') {
      // 自分の操作で答え合わせになった直後は、サーバーに届く前で読む許可がまだないことがある。少し待ってやり直す
      const retry = () => setTimeout(ctx.requestRender, 1000);
      unsubAnswer ??= ctx.store.subscribeTierAnswer(ctx.roomId(), (v) => {
        answer = v;
        ctx.requestRender();
      }, () => { unsubAnswer = null; retry(); });
      unsubGuesses ??= ctx.store.subscribeTierGuesses(ctx.roomId(), (v) => {
        guesses = v;
        guessesLoaded = true;
        ctx.requestRender();
      }, () => { unsubGuesses = null; retry(); });
    } else if (unsubAnswer || unsubGuesses || answer) {
      unsubAnswer?.();
      unsubGuesses?.();
      unsubAnswer = unsubGuesses = null;
      answer = null;
      guesses = {};
      guessesLoaded = false;
    }
  }

  const answerReady = () => !!answer && answer.round === S().round && guessesLoaded;
  // このゲームの予想だけ { uid: [選択肢ID…] }
  function currentGuesses() {
    const out = {};
    Object.entries(guesses).forEach(([uid, g]) => {
      if (g?.round === S().round) out[uid] = g.order ?? [];
    });
    return out;
  }

  // ---------- 演出 ----------

  let fx = null;
  function effects() {
    const s = S();
    const t = s.tier;
    if (s.phase !== 'tier' || !t) {
      fx = null;
      return;
    }
    if (fx && fx.round === s.round) {
      if (t.step === 'predict' && fx.step === 'ranking') {
        ctx.sound.decide();
        ctx.banner(isRanker() ? '📝 順位を決めました！みんなの予想を待とう' : `📝 ${who(t.ranker)}が並べ終わりました！予想を出そう`);
      }
      if (t.step === 'reveal' && fx.step === 'predict') {
        ctx.sound.decide();
        ctx.banner('🔍 予想がそろいました！答え合わせ');
      }
      if (t.count > fx.count) ctx.sound.flip();
      if (t.result && !fx.result) {
        const { winners, perfect } = t.result;
        setTimeout(() => {
          if (perfect.length) {
            ctx.banner(`💯 ${perfect.map(who).join('、')}がパーフェクト！`);
            ctx.confetti();
          } else if (winners.length) {
            ctx.banner(`🏆 ${winners.map(who).join('、')}の勝ち！`);
          }
          ctx.sound.success();
        }, 500);
      }
    }
    fx = { round: s.round, step: t.step, count: t.count, result: !!t.result };
  }

  // ---------- 画面 ----------

  function pickerHtml({ locked = false } = {}) {
    const t = T();
    const { order } = myDraft();
    const slots = Array.from({ length: t.size }, (_, i) => {
      const id = order[i];
      if (id) {
        return `
          <li class="slot filled" ${locked ? '' : `data-action="tier-unpick" data-i="${i}"`}>
            <span class="rank">${i + 1}位</span><span class="slot-text">${esc(textOf(id))}</span>
            ${locked ? '' : '<span class="slot-x" aria-hidden="true">×</span>'}
          </li>`;
      }
      return `<li class="slot"><span class="rank">${i + 1}位</span><span class="slot-text empty">${i === order.length && !locked ? '下の選択肢をタップ' : ''}</span></li>`;
    }).join('');
    const full = order.length >= t.size;
    const pool = optionList().map((o) => {
      const at = order.indexOf(o.id);
      return `
        <button class="opt ${at >= 0 ? 'picked' : ''}" data-action="tier-pick" data-id="${o.id}" ${locked || at >= 0 || full ? 'disabled' : ''}>
          ${at >= 0 ? `<b>${at + 1}</b>` : ''}${esc(o.text)}
        </button>`;
    }).join('');
    return `
      <div class="tier-picker">
        <ol class="tier-slots">${slots}</ol>
        <div class="tier-pool">${pool}</div>
      </div>`;
  }

  function bannerHtml() {
    const t = T();
    return `
      <div class="chooser-banner ${isRanker() ? 'me' : ''}">
        📝 並べる人：<b>${who(t.ranker)}</b>　<span class="banner-sub">上位${t.size}つを選んで順位をつけます</span>
      </div>`;
  }

  function optionsStageHtml() {
    const t = T();
    const opts = optionList();
    const mine = opts.filter((o) => o.by === me()).length;
    const limit = t.free ? ADD_LIMIT_FREE : ADD_LIMIT_PRESET;
    const canAdd = (isRanker() || mine < limit) && opts.length < OPTION_COUNT;
    const canDelete = (o) => isRanker() || ctx.isHost() || o.by === me();
    const full = opts.length >= OPTION_COUNT;
    let hint;
    if (isRanker()) {
      hint = full
        ? `選択肢は${OPTION_COUNT}個です。入れ替えたいときは×で消すと、空いた枠にみんなが足せます`
        : `あと${OPTION_COUNT - opts.length}個そろえてください`;
    } else {
      hint = full
        ? `選択肢は${OPTION_COUNT}個です。足したいときは、並べる人に1つ消してもらいましょう`
        : `空いた枠に選択肢を足せます（あなたはあと${Math.max(0, limit - mine)}個）`;
    }
    return `
      <div class="panel">
        ${bannerHtml()}
        <h3>選択肢 <span class="hint">${hint}</span></h3>
        <div class="opt-list">
          ${opts.map((o) => `
            <span class="opt-chip ${o.by ? 'added' : ''}">
              ${esc(o.text)}${o.by ? `<small>${esc(ctx.nameOf(S(), o.by))}</small>` : ''}
              ${canDelete(o) ? `<button class="chip-x" data-action="tier-del-option" data-id="${o.id}" title="消す">×</button>` : ''}
            </span>`).join('') || '<p class="hint">まだ選択肢がありません。みんなで出し合いましょう</p>'}
        </div>
        ${canAdd ? `
          <form class="tier-add" data-form="tier-add-option">
            <input data-keep="tier-add" maxlength="24" placeholder="選択肢を追加" autocomplete="off">
            <button class="btn" type="submit">追加</button>
          </form>` : ''}
      </div>`;
  }

  function progressHtml() {
    const t = T();
    return `
      <div class="progress">
        <div class="progress-label">予想済み ${t.predictors.filter((id) => t.submitted[id]).length}/${t.predictors.length}人</div>
        <div class="progress-row">
          ${t.predictors.map((id) => `<span class="progress-chip ${t.submitted[id] ? 'done' : ''}">${t.submitted[id] ? '✓' : '…'} ${esc(ctx.nameOf(S(), id))}</span>`).join('')}
        </div>
      </div>`;
  }

  function rankingStageHtml() {
    if (isRanker()) {
      return `
        <div class="panel">
          ${bannerHtml()}
          <h3>あなたの順位を決める <span class="hint">選択肢をタップすると1位から順に入ります。入れたものをタップすると外せます</span></h3>
          ${pickerHtml()}
        </div>`;
    }
    return `
      <div class="panel">
        ${bannerHtml()}
        <h3>予想を組み立てよう <span class="hint">${who(T().ranker)}が並べています。並べ終わったら予想を出せます</span></h3>
        ${pickerHtml()}
      </div>`;
  }

  function predictStageHtml() {
    const t = T();
    if (isRanker()) {
      return `
        <div class="panel input-panel">
          ${bannerHtml()}
          <h3>みんなが予想しています <span class="hint">あなたの順位は答え合わせまで誰にも見えません</span></h3>
          ${pickerHtml({ locked: true })}
          ${progressHtml()}
        </div>`;
    }
    if (!t.predictors.includes(me())) {
      return `<div class="panel waiting">途中から参加したので、今回は見学です。次のゲームから参加できます。</div>`;
    }
    const done = !!t.submitted[me()];
    return `
      <div class="panel">
        ${bannerHtml()}
        <h3>${done ? '予想を出しました' : `${who(t.ranker)}の順位を予想しよう`} <span class="hint">${done ? '全員が出すと答え合わせに進みます' : 'ほかの人の予想は答え合わせまで見えません'}</span></h3>
        ${pickerHtml({ locked: done })}
        ${progressHtml()}
      </div>`;
  }

  function revealStageHtml() {
    const t = T();
    if (!answerReady()) return `<div class="panel waiting">答えを読み込んでいます…</div>`;
    const ans = answer.order;
    const n = ans.length;
    const opened = new Set(Array.from({ length: Math.min(t.count, n) }, (_, k) => n - 1 - k));
    const done = t.count >= n;
    const gs = currentGuesses();
    const answerCol = ans.map((id, i) => `
      <li class="ans ${opened.has(i) ? 'open' : ''} ${!done && i === n - 1 - t.count ? 'next' : ''}">
        <span class="rank">${i + 1}位</span><span class="ans-text">${opened.has(i) ? esc(textOf(id)) : '？'}</span>
      </li>`).join('');
    const rows = t.predictors.map((uid) => {
      const g = gs[uid];
      const color = ctx.colorAttrs(S(), uid);
      const win = done && t.result?.winners.includes(uid);
      if (!g) {
        return `<div class="g-row"><div class="g-name" style="${color.style}">${esc(ctx.nameOf(S(), uid))}</div><div class="g-chips"><span class="hint">予想なし</span></div><div class="g-score">0点</div></div>`;
      }
      let points = 0;
      const chips = g.map((id, i) => {
        const at = ans.indexOf(id);
        const open = at >= 0 ? opened.has(at) : done;
        const m = tierMark(ans, id, i);
        if (open) points += m.points;
        const cls = { '◎': 'hit', '○': 'near', '△': 'in', '×': 'miss' }[m.mark];
        return `
          <span class="g-chip ${open ? cls : ''}">
            <span class="rank">${i + 1}</span><span class="g-text">${esc(textOf(id))}</span>${open ? `<b class="mark">${m.mark}</b>` : ''}
          </span>`;
      }).join('');
      return `
        <div class="g-row ${win ? 'winner' : ''}">
          <div class="g-name" style="${color.style}">${win ? '🏆 ' : ''}${esc(ctx.nameOf(S(), uid))}</div>
          <div class="g-chips">${chips}</div>
          <div class="g-score">${points}点</div>
        </div>`;
    }).join('');
    return `
      <div class="panel tier-reveal">
        <div class="ans-col">
          <div class="ans-head">${who(t.ranker)}の答え</div>
          <ol class="ans-list">${answerCol}</ol>
        </div>
        <div class="guess-col">
          <div class="ans-head">みんなの予想 <span class="hint">◎ぴったり3点 ○1つずれ2点 △入っている1点</span></div>
          ${rows || '<p class="hint">予想した人はいません</p>'}
        </div>
      </div>`;
  }

  function stageHtml() {
    const step = T().step;
    if (step === 'options') return optionsStageHtml();
    if (step === 'ranking') return rankingStageHtml();
    if (step === 'predict') return predictStageHtml();
    return revealStageHtml();
  }

  function controlsHtml() {
    const t = T();
    const lead = isRanker() || ctx.isHost();
    let main = '';
    if (t.step === 'options') {
      const n = Object.keys(t.options).length;
      main = lead
        ? `<button class="btn primary big" data-action="tier-close-options" ${n === OPTION_COUNT ? '' : 'disabled'}>これで並べる</button>
           ${n === OPTION_COUNT ? '' : `<span class="hint">選択肢が${OPTION_COUNT}個そろうと押せます（いま${n}個）</span>`}`
        : `<span class="hint">${who(t.ranker)}が締め切ると、並べ始めます</span>`;
    } else if (t.step === 'ranking') {
      main = isRanker()
        ? `<button class="btn primary big" data-action="tier-confirm-rank" ${myDraft().order.length === t.size ? '' : 'disabled'}>この順位で決定</button>
           <span class="hint">決定すると変えられません</span>`
        : '<span class="hint">並べ終わるまで、予想は出せません</span>';
    } else if (t.step === 'predict') {
      if (t.predictors.includes(me())) {
        main = t.submitted[me()]
          ? '<button class="btn ghost" data-action="tier-redo-guess">出し直す</button>'
          : `<button class="btn primary big" data-action="tier-submit-guess" ${myDraft().order.length === t.size ? '' : 'disabled'}>予想を出す</button>`;
      }
      if (ctx.isHost()) main += '<button class="btn" data-action="tier-close-guess">締め切って答え合わせへ</button>';
    } else if (t.count < t.size) {
      main = lead
        ? `<button class="btn primary big" data-action="tier-flip" ${answerReady() ? '' : 'disabled'}>めくる（${t.count}/${t.size}）</button>
           <span class="hint">下の順位から1つずつ開きます</span>`
        : `<span class="hint">${who(t.ranker)}がめくっています（${t.count}/${t.size}）</span>`;
    } else {
      main = lead ? '<button class="btn primary big" data-action="next-game">次のゲームへ</button>' : '';
    }
    const abort = ctx.isHost() ? '<button class="btn ghost" data-action="abort">ゲームをやめてロビーへ</button>' : '';
    if (!main && !abort) return '';
    return `<div class="panel host-panel row">${main}${abort}</div>`;
  }

  // 参加者一覧に出す一言
  function chipStatus(id) {
    const s = S();
    if (s.phase !== 'tier' || !s.tier) return '';
    const t = s.tier;
    if (t.ranker === id) return '<span class="chip-sub chooser">📝並べる人</span>';
    if (t.step === 'predict' && t.predictors.includes(id)) {
      return t.submitted[id] ? '<span class="chip-sub done">予想済み</span>' : '<span class="chip-sub">予想中</span>';
    }
    return '';
  }

  // ---------- 操作 ----------

  const actions = {
    'tier-pick'(el) {
      const d = myDraft();
      if (d.order.length < T().size && !d.order.includes(el.dataset.id)) d.order.push(el.dataset.id);
      ctx.requestRender();
    },

    'tier-unpick'(el) {
      myDraft().order.splice(Number(el.dataset.i), 1);
      ctx.requestRender();
    },

    'tier-del-option'(el) {
      const id = el.dataset.id;
      const uid = me();
      ctx.update((s) => {
        const o = s.tier?.options[id];
        if (s.phase !== 'tier' || s.tier.step !== 'options' || !o) return undefined;
        if (!(s.tier.ranker === uid || s.hostId === uid || o.by === uid)) return undefined;
        delete s.tier.options[id];
        return s;
      });
    },

    'tier-close-options'() {
      ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== 'options' || Object.keys(s.tier.options).length !== OPTION_COUNT) return undefined;
        s.tier.step = 'ranking';
        return s;
      });
    },

    // 答えを本人しか読めない場所に保存してから、予想に進む
    async 'tier-confirm-rank'() {
      const order = [...myDraft().order];
      if (!isRanker() || T().step !== 'ranking' || order.length !== T().size) return;
      try {
        await ctx.store.setTierAnswer(ctx.roomId(), { round: S().round, order });
      } catch (err) {
        ctx.toast(`保存できませんでした（${err.code ?? err.message}）`);
        return;
      }
      await ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== 'ranking') return undefined;
        s.tier.step = 'predict';
        s.tier.predictors = ctx.playersOf(s).map((p) => p.id).filter((id) => id !== s.tier.ranker);
        s.tier.submitted = {};
        return advance(s);
      });
    },

    async 'tier-submit-guess'() {
      const t = T();
      const order = [...myDraft().order];
      const uid = me();
      if (t.step !== 'predict' || !t.predictors.includes(uid) || order.length !== t.size) return;
      try {
        await ctx.store.setTierGuess(ctx.roomId(), uid, { round: S().round, order });
      } catch (err) {
        ctx.toast(`保存できませんでした（${err.code ?? err.message}）`);
        return;
      }
      await ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== 'predict') return undefined;
        s.tier.submitted[uid] = true;
        return advance(s);
      });
    },

    'tier-redo-guess'() {
      const uid = me();
      ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== 'predict') return undefined;
        delete s.tier.submitted[uid];
        return s;
      });
    },

    // 予想を出していない人がいても、ホストは締め切れる（その人は0点）
    'tier-close-guess'() {
      ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== 'predict') return undefined;
        s.tier.step = 'reveal';
        s.tier.count = 0;
        return s;
      });
    },

    // 1つめくる。最後の1つをめくったら点数を集計し、一番高い人に1勝を付ける
    'tier-flip'() {
      if (!answerReady()) return;
      const ans = answer.order;
      const gs = currentGuesses();
      ctx.update((s) => {
        const t = s.tier;
        if (s.phase !== 'tier' || t.step !== 'reveal' || t.count >= t.size) return undefined;
        t.count += 1;
        if (t.count >= t.size) {
          const scores = Object.fromEntries(t.predictors.map((id) => [id, gs[id] ? tierScore(ans, gs[id]) : 0]));
          const max = Math.max(0, ...Object.values(scores));
          const winners = max > 0 ? Object.keys(scores).filter((id) => scores[id] === max) : [];
          winners.forEach((id) => { s.wins[id] = (s.wins[id] ?? 0) + 1; });
          t.result = { scores, winners, perfect: Object.keys(scores).filter((id) => scores[id] === t.size * 3) };
        }
        return s;
      });
    },
  };

  const forms = {
    'tier-add-option'(form) {
      const input = form.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const uid = me();
      ctx.update((s) => {
        const t = s.tier;
        if (s.phase !== 'tier' || t.step !== 'options') return undefined;
        const list = Object.values(t.options);
        const limit = t.free ? ADD_LIMIT_FREE : ADD_LIMIT_PRESET;
        if (list.length >= OPTION_COUNT) return undefined;
        if (t.ranker !== uid && list.filter((o) => o.by === uid).length >= limit) return undefined;
        if (list.some((o) => o.text === text)) return undefined; // 同じ選択肢は増やさない
        t.options[randomId()] = { text, by: uid, at: ctx.store.now() };
        return s;
      });
    },
  };

  return {
    stageHtml,
    controlsHtml,
    chipStatus,
    actions,
    forms,
    onRender() {
      sync();
      effects();
    },
  };
}
