// カードのドラッグ操作。マウスとスマホのタッチの両方で動くように Pointer Events で実装する。
// [data-drag="カードID"] の要素をつかんで、[data-zone="line"|"staging"] の上で離すと onDrop が呼ばれる。

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
    if (zone === 'line') {
      const index = insertIndex(zoneEl, e.clientX, e.clientY);
      showMarker(zoneEl, index);
      drag.target = { zone, index };
    } else {
      drag.target = { zone, index: Infinity };
    }
  }

  // 折り返した列にも対応した挿入位置の計算
  function insertIndex(zoneEl, x, y) {
    const cards = [...zoneEl.querySelectorAll('[data-drag]')].filter((c) => c.dataset.drag !== drag.id);
    let index = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      const sameRow = y >= r.top - 8 && y <= r.bottom + 8;
      const before = y > r.bottom + 8 || (sameRow && x > r.left + r.width / 2);
      if (before) index++;
    }
    return index;
  }

  function showMarker(zoneEl, index) {
    const cards = [...zoneEl.querySelectorAll('[data-drag]')].filter((c) => c.dataset.drag !== drag.id);
    const marker = document.createElement('div');
    marker.className = 'drop-marker';
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
