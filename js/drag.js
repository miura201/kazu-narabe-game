// カードのドラッグ操作。マウスとスマホのタッチの両方で動くように Pointer Events で実装する。
// [data-drag="ID"] の要素をつかんで、[data-zone="…"] の上で離すと onDrop が呼ばれる。
// 並び順がある場所（数並べの列、Tier表の順位）は data-axis="x"（横に並ぶ）か "y"（縦に並ぶ）を付けると、挿入位置も渡す。

const START_DISTANCE = 6;

export function setupDrag({ onDrop, onDragChange }) {
  let pending = null; // つかんだが、まだ動かしていない状態
  let drag = null; // ドラッグ中の状態

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('[data-drag]');
    if (!el) return;
    // 文字選択やブラウザ標準のドラッグが始まると pointercancel になるので止める
    e.preventDefault();
    pending = { el, id: el.dataset.drag, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  });

  document.addEventListener('dragstart', (e) => {
    if (e.target.closest?.('[data-drag]')) e.preventDefault();
  });

  document.addEventListener('pointermove', (e) => {
    if (pending && !drag) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < START_DISTANCE) return;
      start(pending, e);
    }
    if (!drag) return;
    e.preventDefault();
    move(e);
  }, { passive: false });

  document.addEventListener('pointerup', (e) => {
    if (drag) finish(e);
    pending = null;
  });

  document.addEventListener('pointercancel', () => {
    if (drag) cancel();
    pending = null;
  });

  function start(p, e) {
    const rect = p.el.getBoundingClientRect();
    const ghost = p.el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    p.el.classList.add('dragging');
    drag = { ...p, ghost, offsetX: p.x - rect.left, offsetY: p.y - rect.top, target: null };
    onDragChange?.(true);
    move(e);
  }

  function move(e) {
    drag.ghost.style.transform = `translate(${e.clientX - drag.offsetX}px, ${e.clientY - drag.offsetY}px) rotate(-3deg)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const zoneEl = under?.closest('[data-zone]');
    document.querySelectorAll('.zone-hover').forEach((z) => z !== zoneEl && z.classList.remove('zone-hover'));
    removeMarker();
    if (!zoneEl) {
      drag.target = null;
      return;
    }
    zoneEl.classList.add('zone-hover');
    const zone = zoneEl.dataset.zone;
    const axis = zoneEl.dataset.axis;
    if (axis) {
      const index = insertIndex(zoneEl, e.clientX, e.clientY, axis);
      showMarker(zoneEl, index, axis);
      drag.target = { zone, index };
    } else {
      drag.target = { zone, index: Infinity };
    }
  }

  // 挿入位置の計算。横の列は折り返しにも対応する
  function insertIndex(zoneEl, x, y, axis) {
    const cards = [...zoneEl.querySelectorAll('[data-drag]')].filter((c) => c.dataset.drag !== drag.id);
    let index = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (axis === 'y') {
        if (y > r.top + r.height / 2) index++;
        continue;
      }
      const sameRow = y >= r.top - 8 && y <= r.bottom + 8;
      const before = y > r.bottom + 8 || (sameRow && x > r.left + r.width / 2);
      if (before) index++;
    }
    return index;
  }

  function showMarker(zoneEl, index, axis) {
    const cards = [...zoneEl.querySelectorAll('[data-drag]')].filter((c) => c.dataset.drag !== drag.id);
    const marker = document.createElement(zoneEl.tagName === 'OL' ? 'li' : 'div');
    marker.className = `drop-marker ${axis === 'y' ? 'y' : ''}`;
    const list = zoneEl.querySelector('.card-row') ?? zoneEl;
    if (index < cards.length) list.insertBefore(marker, cards[index]);
    else list.appendChild(marker);
  }

  function removeMarker() {
    document.querySelectorAll('.drop-marker').forEach((m) => m.remove());
  }

  function cleanup() {
    drag.ghost.remove();
    drag.el.classList.remove('dragging');
    removeMarker();
    document.querySelectorAll('.zone-hover').forEach((z) => z.classList.remove('zone-hover'));
    drag = null;
    onDragChange?.(false);
  }

  function finish() {
    const { id, target } = drag;
    cleanup();
    if (target) onDrop(id, target.zone, target.index);
  }

  function cancel() {
    cleanup();
  }
}
