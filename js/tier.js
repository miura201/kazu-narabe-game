// Tier表作成ゲーム。モードは2つ。
//   当てる（guess）：並べる人の順位をほかの人が予想する。
//     選択肢を集める（options）→ 並べる人が順位をつける（ranking）→ 予想の締め切りを待つ（predict）→ 答え合わせ（reveal）
//     ほかの人は ranking の間から予想を出せる。並べる人が決定し、全員の予想がそろうと答え合わせに進む。
//   相性診断（match）：全員が自分の順位をつけ、2人ずつの近さを貯めていく。決めた回数で結果発表。
//     選択肢を集める（options）→ 全員が順位をつける（ranking）→ 公開（reveal）
//     ranker はお題番（選択肢の締め切りとめくる係）で、本人も順位をつける。
// 並べる人の答えと各自の予想は、答え合わせまで本人しか読めない場所に保存する（store.js / database.rules.json）。

import { randomId, tierMark, tierScore, matchScore, pairKey } from './logic.js';
import { tierOptionsFor } from './tier-topics.js';

const ADD_LIMIT_PRESET = 2; // 用意した選択肢があるお題で、1人が追加できる数（並べる人は無制限）
const ADD_LIMIT_FREE = 5; // 自由入力のお題で、1人が追加できる数
// 選択肢の数で難しさが変わらないよう、毎回ちょうどこの数から選ぶ。足したいときは枠を空けて入れ替える
const OPTION_COUNT = 10;

const GUESSING = ['ranking', 'predict']; // 予想を出せる段階

// お題が決まったら Tier表のゲームを始める。お題番がそのまま並べる人になる
export function startTier(s) {
  const options = {};
  tierOptionsFor(s.topic.current).forEach((text, i) => {
    options[randomId()] = { text, by: null, at: i };
  });
  s.phase = 'tier';
  s.round += 1;
  s.tier = {
    mode: s.tierMode === 'match' ? 'match' : 'guess',
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

// 当てる：並べる人が決定し、全員が予想を出したら答え合わせへ進む
// 相性診断：全員が順位を決めたら公開へ進む
function advance(s) {
  const t = s.tier;
  const ready = t.mode === 'match' ? t.step === 'ranking' && t.predictors.length > 0 : t.step === 'predict';
  if (ready && t.predictors.every((id) => t.submitted[id])) {
    t.step = 'reveal';
    t.count = 0;
  }
  return s;
}

// 部屋から人が抜けたとき。並べる人が抜けたら続けられないので false を返す（ロビーに戻す）
export function tierRemovePlayer(s, id) {
  if (s.phase !== 'tier' || !s.tier) return true;
  s.tier.predictors = s.tier.predictors.filter((x) => x !== id);
  if (s.tier.ranker === id) {
    // 相性診断のお題番は進行係なので、残った人に引き継ぐ
    if (s.tier.mode !== 'match') return false;
    s.tier.ranker = s.tier.predictors[0] ?? s.hostId;
  }
  delete s.tier.submitted[id];
  advance(s);
  return true;
}

export function createTier(ctx) {
  const { esc } = ctx;
  const S = () => ctx.state();
  const T = () => S().tier;
  const me = () => ctx.pid();
  const isMatch = () => T()?.mode === 'match';
  // 当てるモードで順位を当てられる人。相性診断では全員が順位をつける側なので、誰も当てはまらない
  const isRanker = () => !isMatch() && T()?.ranker === me();
  // 選択肢の締め切りとめくる係（当てる：並べる人、相性診断：お題番）
  const isLead = () => T()?.ranker === me();
  const isPredictor = () => !!T()?.predictors.includes(me());
  const who = (id) => (id === me() ? 'あなた' : `${esc(ctx.nameOf(S(), id))} さん`);
  // めくるのは係の人。係の人の通信が切れているときだけ、ホストが代わりにめくれる
  const canFlip = () => isLead() || (ctx.isHost() && !ctx.isOnline(T().ranker));

  // 自分が組み立て中の順位（まだ保存していない）。ゲームと役割が変わったら作り直す
  let draft = { key: null, order: [] };
  function myDraft() {
    const key = `${S().round}:${isRanker() ? 'answer' : 'guess'}`;
    if (draft.key !== key) draft = { key, order: [] };
    draft.order = draft.order.filter((id) => T().options[id]);
    return draft;
  }

  // いま自分の順位を動かせるか
  function canEdit() {
    const t = T();
    if (isMatch()) return isPredictor() && t.step === 'ranking' && !t.submitted[me()];
    if (isRanker()) return t.step === 'ranking';
    return isPredictor() && GUESSING.includes(t.step) && !t.submitted[me()];
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
      if (!isMatch()) unsubAnswer ??= ctx.store.subscribeTierAnswer(ctx.roomId(), (v) => {
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

  // 相性診断は全員の順位（予想と同じ場所）だけを使う
  const answerReady = () => guessesLoaded && (isMatch() || (!!answer && answer.round === S().round));
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
  let lastPhase = null;
  function effects() {
    const s = S();
    if (s.phase === 'matchResult' && lastPhase && lastPhase !== 'matchResult') {
      ctx.banner('🤝 結果発表！');
      ctx.confetti();
      ctx.sound.success();
    }
    lastPhase = s.phase;
    const t = s.tier;
    if (s.phase !== 'tier' || !t) {
      fx = null;
      return;
    }
    if (fx && fx.round === s.round && t.mode === 'match') {
      matchEffects(t);
    } else if (fx && fx.round === s.round) {
      if (t.step !== 'options' && fx.step === 'options') ctx.banner(`📝 選択肢が決まりました！${isRanker() ? '順位をつけよう' : '予想を組み立てよう'}`);
      if (t.step !== 'ranking' && fx.step === 'ranking') {
        ctx.sound.decide();
        if (isRanker()) ctx.banner('📝 順位を決めました！みんなの予想を待とう');
        else ctx.banner(`📝 ${who(t.ranker)}が並べ終わりました！${t.submitted[me()] ? '' : '予想を出そう'}`);
      }
      if (t.step === 'reveal' && fx.step === 'predict') {
        ctx.sound.decide();
        ctx.banner('🔍 予想がそろいました！答え合わせ');
      }
      if (t.count > fx.count) ctx.sound.flip();
      if (t.result && !fx.result) {
        const { winners, perfect, scores } = t.result;
        setTimeout(() => {
          if (perfect.length) {
            ctx.banner(`💯 ${perfect.map(who).join('、')}がパーフェクト！`);
            ctx.confetti();
          } else if (winners.length) {
            ctx.banner(`🏆 ${winners.map(who).join('、')}の勝ち！`);
          } else if (t.predictors.length === 1) {
            // 予想した人が1人だけのときは勝ち負けがないので、点数だけ知らせる
            const [only] = t.predictors;
            ctx.banner(`${who(only)}は ${scores[only] ?? 0}点！`);
          }
          ctx.sound.success();
        }, 500);
      }
    }
    fx = { round: s.round, step: t.step, count: t.count, result: !!t.result };
  }

  // 相性診断：1段めくるたびに、その順位が全員一致していたら知らせる。最後に全体の演出
  function matchEffects(t) {
    if (t.step === 'ranking' && fx.step === 'options') ctx.banner('🤝 選択肢が決まりました！自分の順位をつけよう');
    if (t.step === 'reveal' && fx.step === 'ranking') {
      ctx.sound.decide();
      ctx.banner('🔍 全員そろいました！公開します');
    }
    if (t.count > fx.count) {
      ctx.sound.flip();
      const gs = currentGuesses();
      const rank = t.size - t.count; // いま開いた順位（0 始まり）
      const items = t.predictors.map((id) => gs[id]?.[rank]).filter(Boolean);
      const same = items.length >= 2 && items.length === t.predictors.length && items.every((x) => x === items[0]);
      if (same && !t.result) ctx.banner(`✨ ${rank + 1}位は全員一致！`);
    }
    if (t.result && !fx.result) {
      const { allSame, firstSame, destiny } = t.result;
      setTimeout(() => {
        if (allSame) {
          ctx.banner('🎉 全員の順位が完全一致！');
          ctx.confetti();
          ctx.sound.success();
        } else if (destiny.length) {
          const names = destiny.map((k) => k.split('_').map(who).join(' と ')).join('、');
          ctx.banner(`💘 運命の2人：${names}`);
          ctx.confetti();
          ctx.sound.success();
        } else if (firstSame) {
          ctx.banner('✨ 1位は全員一致！');
          ctx.sound.success();
        }
      }, 500);
    }
  }

  // ---------- 画面 ----------

  // 順位の枠（上）と選択肢（下）。タップで入れ外しでき、ドラッグでも並べ替えられる
  function pickerHtml() {
    const t = T();
    const edit = canEdit();
    const { order } = myDraft();
    const slots = Array.from({ length: t.size }, (_, i) => {
      const id = order[i];
      if (id) {
        return `
          <li class="slot filled" ${edit ? `data-action="tier-unpick" data-i="${i}" data-drag="tier:${id}"` : ''}>
            <span class="rank">${i + 1}位</span><span class="slot-text">${esc(textOf(id))}</span>
            ${edit ? '<span class="slot-grip" aria-hidden="true">⠿</span>' : ''}
          </li>`;
      }
      return `<li class="slot"><span class="rank">${i + 1}位</span><span class="slot-text empty">${i === order.length && edit ? 'タップかドラッグで入れる' : ''}</span></li>`;
    }).join('');
    const full = order.length >= t.size;
    const pool = optionList().map((o) => {
      const at = order.indexOf(o.id);
      const usable = edit && at < 0 && !full;
      return `
        <button class="opt ${at >= 0 ? 'picked' : ''}" data-action="tier-pick" data-id="${o.id}" ${usable ? `data-drag="tier:${o.id}"` : 'disabled'}>
          ${at >= 0 ? `<b>${at + 1}</b>` : ''}${esc(o.text)}
        </button>`;
    }).join('');
    return `
      <div class="tier-picker">
        <ol class="tier-slots" ${edit ? 'data-zone="tier-slots" data-axis="y"' : ''}>${slots}</ol>
        <div class="tier-pool" ${edit ? 'data-zone="tier-pool"' : ''}>${pool}</div>
      </div>
      ${edit ? '<p class="hint">入れたものはドラッグで並べ替えられます。タップすると外せます</p>' : ''}`;
  }

  function bannerHtml() {
    const t = T();
    if (isMatch()) {
      const m = S().match;
      const total = S().settings.matchRounds;
      return `
      <div class="chooser-banner">
        🤝 相性診断 <b>${(m?.rounds ?? 0) + (t.result ? 0 : 1)}回目</b>${total ? ` / ${total}回` : ''}　<span class="banner-sub">お題番：${who(t.ranker)}・全員が上位${t.size}つを選んで順位をつけます</span>
      </div>`;
    }
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
    const canAdd = (isLead() || mine < limit) && opts.length < OPTION_COUNT;
    const canDelete = (o) => isLead() || ctx.isHost() || o.by === me();
    const full = opts.length >= OPTION_COUNT;
    let hint;
    if (isLead()) {
      hint = full
        ? `選択肢は${OPTION_COUNT}個です。入れ替えたいときは×で消すと、空いた枠にみんなが足せます`
        : `あと${OPTION_COUNT - opts.length}個そろえてください`;
    } else {
      hint = full
        ? `選択肢は${OPTION_COUNT}個です。足したいときは、${isMatch() ? 'お題番' : '並べる人'}に1つ消してもらいましょう`
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
        <div class="progress-label">${isMatch() ? '決定済み' : '予想済み'} ${t.predictors.filter((id) => t.submitted[id]).length}/${t.predictors.length}人</div>
        <div class="progress-row">
          ${t.predictors.map((id) => `<span class="progress-chip ${t.submitted[id] ? 'done' : ''}">${t.submitted[id] ? '✓' : '…'} ${esc(ctx.nameOf(S(), id))}</span>`).join('')}
        </div>
      </div>`;
  }

  // 順位を決める・予想する画面（ranking と predict で共通）
  function guessingStageHtml() {
    const t = T();
    if (isMatch()) {
      if (!isPredictor()) return '<div class="panel waiting">途中から参加したので、今回は見学です。次のゲームから参加できます。</div>';
      const done = !!t.submitted[me()];
      return `
        <div class="panel">
          ${bannerHtml()}
          <h3>${done ? '順位を決めました' : 'あなたの順位をつけよう'} <span class="hint">${done ? '全員がそろうと公開します' : 'ほかの人の順位は、全員がそろうまで見えません'}</span></h3>
          ${pickerHtml()}
          ${progressHtml()}
        </div>`;
    }
    if (isRanker()) {
      const deciding = t.step === 'ranking';
      return `
        <div class="panel">
          ${bannerHtml()}
          <h3>${deciding ? 'あなたの順位を決める' : 'みんなが予想しています'} <span class="hint">${deciding ? '選択肢をタップすると1位から順に入ります' : 'あなたの順位は答え合わせまで誰にも見えません'}</span></h3>
          ${pickerHtml()}
          ${progressHtml()}
        </div>`;
    }
    if (!isPredictor()) {
      return '<div class="panel waiting">途中から参加したので、今回は見学です。次のゲームから参加できます。</div>';
    }
    const done = !!t.submitted[me()];
    const ranking = t.step === 'ranking' ? `${who(t.ranker)}はまだ並べています。先に予想を出してもOKです` : `${who(t.ranker)}は並べ終わりました`;
    return `
      <div class="panel">
        ${bannerHtml()}
        <h3>${done ? '予想を出しました' : `${who(t.ranker)}の順位を予想しよう`} <span class="hint">${done ? '全員がそろうと答え合わせに進みます' : `${ranking}。ほかの人の予想は答え合わせまで見えません`}</span></h3>
        ${pickerHtml()}
        ${progressHtml()}
      </div>`;
  }

  // 答え合わせ。並べた人の答えを下の順位から開き、開いた選択肢をみんながどこに置いていたかを同時に見せる。
  // 答えに入っていない予想（×）は、最後まで開いたときにまとめて見せる
  function revealStageHtml() {
    const t = T();
    if (!answerReady()) return '<div class="panel waiting">答えを読み込んでいます…</div>';
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
        if (!open) return `<span class="g-chip closed"><span class="rank">${i + 1}</span><span class="g-text">？</span></span>`;
        const m = tierMark(ans, id, i);
        points += m.points;
        const cls = { '◎': 'hit', '○': 'near', '△': 'in', '×': 'miss' }[m.mark];
        return `
          <span class="g-chip ${cls}">
            <span class="rank">${i + 1}</span><span class="g-text">${esc(textOf(id))}</span><b class="mark">${m.mark}</b>
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

  // 相性診断の公開。全員の順位を1人1行で並べ、下の順位から1段ずつ開く。
  // 同じ順位に同じものを置いた人が2人以上いたら、その選択肢に色を付けてつながりが見えるようにする
  function matchRevealHtml() {
    const t = T();
    if (!answerReady()) return '<div class="panel waiting">みんなの順位を読み込んでいます…</div>';
    const gs = currentGuesses();
    const n = t.size;
    const opened = new Set(Array.from({ length: Math.min(t.count, n) }, (_, k) => n - 1 - k));
    // 順位ごとに、2人以上が置いた選択肢に色番号を振る
    const shared = Array.from({ length: n }, (_, r) => {
      const counts = {};
      t.predictors.forEach((id) => {
        const x = gs[id]?.[r];
        if (x) counts[x] = (counts[x] ?? 0) + 1;
      });
      const tags = {};
      Object.keys(counts).filter((x) => counts[x] >= 2).forEach((x, i) => { tags[x] = i % 4; });
      return tags;
    });
    const rows = t.predictors.map((uid) => {
      const g = gs[uid];
      const color = ctx.colorAttrs(S(), uid);
      const chips = g
        ? g.map((id, i) => {
          if (!opened.has(i)) return `<span class="g-chip closed"><span class="rank">${i + 1}</span><span class="g-text">？</span></span>`;
          const tag = shared[i][id];
          return `<span class="g-chip ${tag !== undefined ? `same same-${tag}` : ''}"><span class="rank">${i + 1}</span><span class="g-text">${esc(textOf(id))}</span></span>`;
        }).join('')
        : '<span class="hint">順位なし</span>';
      return `
        <div class="g-row match-row">
          <div class="g-name" style="${color.style}">${esc(ctx.nameOf(S(), uid))}</div>
          <div class="g-chips">${chips}</div>
        </div>`;
    }).join('');
    return `
      <div class="panel">
        ${bannerHtml()}
        <div class="ans-head">みんなの順位 <span class="hint">同じ順位に同じものを置いた人どうしは、同じ色で光ります</span></div>
        ${rows}
      </div>`;
  }

  function stageHtml() {
    const step = T().step;
    if (step === 'options') return optionsStageHtml();
    if (GUESSING.includes(step)) return guessingStageHtml();
    return isMatch() ? matchRevealHtml() : revealStageHtml();
  }

  function controlsHtml() {
    const t = T();
    const lead = isLead() || ctx.isHost();
    let main = '';
    if (t.step === 'options') {
      const n = Object.keys(t.options).length;
      main = lead
        ? `<button class="btn primary big" data-action="tier-close-options" ${n === OPTION_COUNT ? '' : 'disabled'}>これで並べる</button>
           ${n === OPTION_COUNT ? '' : `<span class="hint">選択肢が${OPTION_COUNT}個そろうと押せます（いま${n}個）</span>`}`
        : `<span class="hint">${who(t.ranker)}が締め切ると、${isMatch() ? '順位をつけ始めます' : '並べ始めます'}</span>`;
    } else if (GUESSING.includes(t.step)) {
      if (isRanker() && t.step === 'ranking') {
        main = `<button class="btn primary big" data-action="tier-confirm-rank" ${myDraft().order.length === t.size ? '' : 'disabled'}>この順位で決定</button>
           <span class="hint">決定すると変えられません</span>`;
      } else if (isPredictor()) {
        main = t.submitted[me()]
          ? `<button class="btn ghost" data-action="tier-redo-guess">${isMatch() ? '決め直す' : '出し直す'}</button>`
          : `<button class="btn primary big" data-action="tier-submit-guess" ${myDraft().order.length === t.size ? '' : 'disabled'}>${isMatch() ? 'この順位で決定' : '予想を出す'}</button>`;
      }
      if (ctx.isHost() && t.step === (isMatch() ? 'ranking' : 'predict')) {
        main += `<button class="btn" data-action="tier-close-guess">${isMatch() ? '締め切って公開' : '締め切って答え合わせへ'}</button>`;
      }
    } else if (t.count < t.size) {
      main = canFlip()
        ? `<button class="btn primary big" data-action="tier-flip" ${answerReady() ? '' : 'disabled'}>めくる（${t.count}/${t.size}）</button>
           <span class="hint">下の順位から1つずつ開きます</span>`
        : `<span class="hint">${who(t.ranker)}がめくっています（${t.count}/${t.size}）</span>`;
    } else if (isMatch()) {
      const total = S().settings.matchRounds;
      const finished = total && (S().match?.rounds ?? 0) >= total;
      if (finished) {
        main = lead ? '<button class="btn primary big" data-action="match-result">結果発表へ</button>' : '<span class="hint">まもなく結果発表です</span>';
      } else {
        main = lead ? '<button class="btn primary big" data-action="next-game">続ける</button><span class="hint">次の人がお題を選びます</span>' : '';
        if (ctx.isHost()) main += '<button class="btn" data-action="match-result">ここで結果発表</button>';
      }
    } else {
      main = lead ? '<button class="btn primary big" data-action="next-game">続ける</button><span class="hint">次の人がお題を選びます</span>' : '';
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
    const lead = t.ranker === id ? `<span class="chip-sub chooser">${t.mode === 'match' ? '🎲お題番' : '📝並べる人'}</span>` : '';
    if (t.mode !== 'match' && lead) return lead;
    if (GUESSING.includes(t.step) && t.predictors.includes(id)) {
      const label = t.mode === 'match' ? ['決定済み', '考え中'] : ['予想済み', '予想中'];
      return lead + (t.submitted[id] ? `<span class="chip-sub done">${label[0]}</span>` : `<span class="chip-sub">${label[1]}</span>`);
    }
    if (lead) return lead;
    return '';
  }

  // ---------- 操作 ----------

  const actions = {
    'tier-pick'(el) {
      const d = myDraft();
      if (!canEdit()) return;
      if (d.order.length < T().size && !d.order.includes(el.dataset.id)) d.order.push(el.dataset.id);
      ctx.requestRender();
    },

    'tier-unpick'(el) {
      if (!canEdit()) return;
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

    // 選択肢を締め切る。この時点の参加者が予想する人になる
    'tier-close-options'() {
      ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== 'options' || Object.keys(s.tier.options).length !== OPTION_COUNT) return undefined;
        s.tier.step = 'ranking';
        // 相性診断はお題番も順位をつける
        s.tier.predictors = ctx.playersOf(s).map((p) => p.id).filter((id) => s.tier.mode === 'match' || id !== s.tier.ranker);
        s.tier.submitted = {};
        return s;
      });
    },

    // 答えを本人しか読めない場所に保存してから、決定したことを知らせる
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
        return advance(s);
      });
    },

    async 'tier-submit-guess'() {
      const t = T();
      const order = [...myDraft().order];
      const uid = me();
      if (!GUESSING.includes(t.step) || !isPredictor() || order.length !== t.size) return;
      try {
        await ctx.store.setTierGuess(ctx.roomId(), uid, { round: S().round, order });
      } catch (err) {
        ctx.toast(`保存できませんでした（${err.code ?? err.message}）`);
        return;
      }
      await ctx.update((s) => {
        if (s.phase !== 'tier' || !GUESSING.includes(s.tier.step)) return undefined;
        s.tier.submitted[uid] = true;
        return advance(s);
      });
    },

    'tier-redo-guess'() {
      const uid = me();
      ctx.update((s) => {
        if (s.phase !== 'tier' || !GUESSING.includes(s.tier.step)) return undefined;
        delete s.tier.submitted[uid];
        return s;
      });
    },

    // 予想を出していない人がいても、ホストは締め切れる（その人は0点）
    'tier-close-guess'() {
      ctx.update((s) => {
        if (s.phase !== 'tier' || s.tier.step !== (s.tier.mode === 'match' ? 'ranking' : 'predict')) return undefined;
        s.tier.step = 'reveal';
        s.tier.count = 0;
        return s;
      });
    },

    // 1つめくる。最後の1つをめくったら点数を集計する。
    // 予想した人が2人以上いるときだけ、一番高い人に1勝を付ける（1人だと勝ち負けにならない）
    'tier-flip'() {
      if (!answerReady() || !canFlip()) return;
      const ans = isMatch() ? null : answer.order; // 相性診断には並べる人の答えがない
      const gs = currentGuesses();
      ctx.update((s) => {
        const t = s.tier;
        if (s.phase !== 'tier' || t.step !== 'reveal' || t.count >= t.size) return undefined;
        t.count += 1;
        if (t.count >= t.size && t.mode === 'match') {
          tallyMatch(s, gs);
        } else if (t.count >= t.size) {
          const scores = Object.fromEntries(t.predictors.map((id) => [id, gs[id] ? tierScore(ans, gs[id]) : 0]));
          const max = Math.max(0, ...Object.values(scores));
          const winners = t.predictors.length >= 2 && max > 0 ? Object.keys(scores).filter((id) => scores[id] === max) : [];
          winners.forEach((id) => { s.wins[id] = (s.wins[id] ?? 0) + 1; });
          t.result = { scores, winners, perfect: Object.keys(scores).filter((id) => scores[id] === t.size * 3) };
        }
        return s;
      });
    },
  };

  // 相性診断：2人ずつの近さを貯める。全員一致・1位一致・完全一致の2人組は演出用に残す
  function tallyMatch(s, gs) {
    const t = s.tier;
    const ids = t.predictors.filter((id) => gs[id]?.length);
    const full = t.size * 3;
    s.match ??= { rounds: 0, pairs: {} };
    s.match.rounds += 1;
    const destiny = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i], ids[j]);
        const score = matchScore(gs[ids[i]], gs[ids[j]]);
        const p = s.match.pairs[key] ?? { sum: 0, max: 0 };
        s.match.pairs[key] = { sum: p.sum + score, max: p.max + full };
        if (score === full) destiny.push(key);
      }
    }
    const pairCount = (ids.length * (ids.length - 1)) / 2;
    t.result = {
      allSame: ids.length >= 3 && destiny.length === pairCount,
      firstSame: ids.length >= 2 && ids.every((id) => gs[id][0] === gs[ids[0]][0]),
      destiny,
    };
  }

  // ---------- 相性診断の結果発表 ----------

  const pct = (p) => (p.max ? Math.round((p.sum / p.max) * 100) : 0);

  function pairNames(a, b) {
    const name = (id) => `<span class="pair-name" style="${ctx.colorAttrs(S(), id).style}">${esc(ctx.nameOf(S(), id))}</span>`;
    return `${name(a)}<span class="pair-and">×</span>${name(b)}`;
  }

  function pairRow(p, label = '') {
    return `
      <div class="pair-row">
        <span class="pair-label">${label}</span>
        <span class="pair-names">${pairNames(p.a, p.b)}</span>
        <span class="pair-bar"><i style="width:${p.pct}%"></i></span>
        <b class="pair-pct">${p.pct}%</b>
      </div>`;
  }

  function matchResultHtml() {
    const s = S();
    const m = s.match ?? { rounds: 0, pairs: {} };
    const present = new Set(Object.keys(s.players));
    // 退出した人を含む組は出さない
    const pairs = Object.entries(m.pairs)
      .map(([k, p]) => {
        const [a, b] = k.split('_');
        return { a, b, pct: pct(p) };
      })
      .filter((p) => present.has(p.a) && present.has(p.b))
      .sort((x, y) => y.pct - x.pct);
    let body;
    if (pairs.length === 0) {
      body = '<p class="hint">まだ診断した組がありません</p>';
    } else if (pairs.length === 1) {
      body = `
        <div class="duo">
          <div class="duo-names">${pairNames(pairs[0].a, pairs[0].b)}</div>
          <div class="duo-pct">${pairs[0].pct}<small>%</small></div>
          <div class="hint">2人の相性（${m.rounds}回の平均）</div>
        </div>`;
    } else {
      const medals = ['🥇', '🥈', '🥉'];
      const best = pairs.slice(0, 3).map((p, i) => pairRow(p, medals[i])).join('');
      const worst = pairs.length > 3 ? pairRow(pairs[pairs.length - 1], '💔') : '';
      // 各自の一番相性がいい人
      const each = ctx.playersOf(s).map((pl) => {
        const mine = pairs.filter((p) => p.a === pl.id || p.b === pl.id);
        if (!mine.length) return '';
        const top = mine[0];
        const other = top.a === pl.id ? top.b : top.a;
        return `<li>${pairNames(pl.id, other)} <b>${top.pct}%</b></li>`;
      }).join('');
      body = `
        <h4>相性ベスト3</h4>
        ${best}
        ${worst ? `<h4>相性ワースト</h4>${worst}` : ''}
        <h4>それぞれの一番相性がいい人</h4>
        <ul class="each-best">${each}</ul>`;
    }
    return `
      <div class="panel match-result">
        <div class="result-title">🤝 相性診断の結果</div>
        <p class="hint">${m.rounds}回分の答えから計算しました</p>
        ${body}
      </div>`;
  }

  function matchResultControlsHtml() {
    if (!ctx.isHost()) return '<div class="panel waiting">ホストが次に遊ぶものを選んでいます…</div>';
    return `
      <div class="panel host-panel row">
        <button class="btn primary big" data-action="match-again">もう一度診断する</button>
        <span class="hint">相性はリセットされます</span>
        <button class="btn ghost" data-action="abort">ロビーに戻る</button>
      </div>`;
  }

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

  // ドラッグで離したとき。順位の枠に入れる・枠の中で並べ替える・選択肢に戻す
  function onDrop(dragId, zone, index) {
    const id = dragId.replace(/^tier:/, '');
    if (!canEdit() || !T().options[id]) return;
    const d = myDraft();
    const rest = d.order.filter((x) => x !== id);
    if (zone === 'tier-slots') {
      if (rest.length >= T().size) return;
      rest.splice(Math.min(index, rest.length), 0, id);
    }
    d.order = rest;
    ctx.requestRender();
  }

  return {
    stageHtml,
    controlsHtml,
    matchResultHtml,
    matchResultControlsHtml,
    chipStatus,
    actions,
    forms,
    onDrop,
    onRender() {
      sync();
      effects();
    },
  };
}
