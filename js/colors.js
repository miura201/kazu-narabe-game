// 名前と一緒に選ぶカードの色

export const PALETTE = [
  { hex: '#3b3f8f', name: '紺' },
  { hex: '#2563eb', name: '青' },
  { hex: '#0ea5e9', name: '水色' },
  { hex: '#0d9488', name: '青緑' },
  { hex: '#5eead4', name: 'ミント' },
  { hex: '#16a34a', name: '緑' },
  { hex: '#84cc16', name: '黄緑' },
  { hex: '#facc15', name: '黄' },
  { hex: '#f59e0b', name: '山吹' },
  { hex: '#ea580c', name: 'オレンジ' },
  { hex: '#dc2626', name: '赤' },
  { hex: '#e11d48', name: 'ローズ' },
  { hex: '#f472b6', name: 'ピンク' },
  { hex: '#c026d3', name: 'マゼンタ' },
  { hex: '#9333ea', name: '紫' },
  { hex: '#a78bfa', name: 'ラベンダー' },
  { hex: '#d6a26b', name: 'ベージュ' },
  { hex: '#92400e', name: '茶' },
  { hex: '#64748b', name: 'グレー' },
  { hex: '#1f2937', name: '黒' },
];

export const DEFAULT_COLOR = PALETTE[0].hex;

export function randomColor() {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)].hex;
}

export const isColor = (v) => /^#[0-9a-f]{6}$/i.test(v ?? '');

// 明るい色の上では白い文字が読みにくいので、黒い文字に切り替える
export function isLight(hex) {
  if (!isColor(hex)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.62;
}
