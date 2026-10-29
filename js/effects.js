// 効果音と演出。音声ファイルは使わず、ブラウザの Web Audio で合成する。

const MUTE_KEY = 'knr:muted';
let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // 保存できない環境では毎回オンから始める
}

// スマホのブラウザは、画面に一度触れるまで音を鳴らせないので、最初の操作で準備する
function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
}
document.addEventListener('pointerdown', unlock);
document.addEventListener('keydown', unlock);

// 1音を鳴らす。start は今からの秒数
function tone({ freq, start = 0, dur = 0.12, type = 'sine', gain = 0.2, slideTo = null }) {
  if (muted || !ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sound = {
  get muted() {
    return muted;
  },

  setMuted(value) {
    muted = value;
    try {
      localStorage.setItem(MUTE_KEY, value ? '1' : '0');
    } catch {
      // 保存できなくても、この画面の間は設定が効く
    }
  },

  // ルーレットが1つ進むとき
  tick() {
    tone({ freq: 1200, dur: 0.03, type: 'square', gain: 0.05 });
  },

  // ルーレットが止まったとき
  decide() {
    tone({ freq: 660, dur: 0.12, type: 'triangle', gain: 0.2 });
    tone({ freq: 990, start: 0.1, dur: 0.25, type: 'triangle', gain: 0.2 });
  },

  // カードが場に出たとき
  pop() {
    tone({ freq: 500, dur: 0.08, type: 'sine', gain: 0.18, slideTo: 900 });
  },

  // カードをめくったとき
  flip() {
    tone({ freq: 300, dur: 0.09, type: 'triangle', gain: 0.22, slideTo: 700 });
  },

  // めくったカードの順番が逆だったとき
  wrong() {
    tone({ freq: 150, dur: 0.35, type: 'sawtooth', gain: 0.12, slideTo: 90 });
  },

  success() {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, start: i * 0.11, dur: 0.22, type: 'triangle', gain: 0.2 }));
    tone({ freq: 1047, start: 0.5, dur: 0.5, type: 'triangle', gain: 0.18 });
  },

  fail() {
    [392, 349, 294].forEach((f, i) => tone({ freq: f, start: i * 0.18, dur: 0.3, type: 'triangle', gain: 0.18 }));
  },
};

// 成功したときの紙吹雪
export function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ff6b57', '#3b3f8f', '#22a06b', '#f59e0b', '#ec4899', '#38bdf8'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < 120; i++) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    piece.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 200}px`);
    piece.style.setProperty('--spin', `${(Math.random() - 0.5) * 1440}deg`);
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 4500);
}
