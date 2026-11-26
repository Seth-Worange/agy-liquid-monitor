const renderedContent = new WeakMap();

function setHeatmapFocus(cell) {
  const grid = cell.closest('.heat-grid');
  grid.querySelector('[tabindex="0"]')?.setAttribute('tabindex', '-1');
  cell.tabIndex = 0;
}

function heatmapKeydown(event) {
  const cell = event.target.closest('.heat-cell');
  if (!cell || event.altKey || event.ctrlKey || event.metaKey) return;
  const grid = cell.closest('.heat-grid');
  const cells = [...grid.querySelectorAll('.heat-cell')];
  const columns = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
  const index = cells.indexOf(cell);
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : index + offsets[event.key];
  if (!Number.isFinite(next)) return;
  event.preventDefault();
  const target = cells[Math.max(0, Math.min(cells.length - 1, next))];
  setHeatmapFocus(target);
  target.focus();
}

function renderWithFocus(root, html, fallback) {
  if (renderedContent.get(root) === html) return;
  const active = root.getRootNode().activeElement;
  const wasFocused = root.contains(active);
  const key = wasFocused && ['id', 'data-date', 'data-period', 'data-remove', 'data-go', 'data-clear']
    .find((name) => active.hasAttribute(name));
  const value = key && active.getAttribute(key);
  root.innerHTML = html;
  renderedContent.set(root, html);
  if (!wasFocused) return;
  const match = key && [...root.querySelectorAll(`[${key}]`)].find((element) => element.getAttribute(key) === value);
  const next = match || fallback?.();
  if (next?.matches('.heat-cell')) setHeatmapFocus(next);
  next?.focus({ preventScroll: true });
}
