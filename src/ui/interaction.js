const renderedContent = new WeakMap();

function createRefreshFeedback(button) {
  const icon = button.querySelector('svg');
  const original = { viewBox: icon.getAttribute('viewBox'), paths: icon.innerHTML, title: button.title };
  const status = document.createElement('span');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  button.after(status);
  let resetTimer;

  function reset() {
    delete button.dataset.refreshState;
    button.title = original.title;
    status.textContent = '';
    icon.setAttribute('viewBox', original.viewBox);
    icon.innerHTML = original.paths;
  }

  return {
    begin() {
      if (button.dataset.refreshState === 'loading') return false;
      clearTimeout(resetTimer);
      reset();
      button.dataset.refreshState = 'loading';
      button.setAttribute('aria-disabled', 'true');
      button.title = status.textContent = '正在刷新数据';
      return true;
    },
    finish(success) {
      if (button.dataset.refreshState !== 'loading') return;
      button.removeAttribute('aria-disabled');
      button.dataset.refreshState = success ? 'success' : 'error';
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.innerHTML = success ? '<path d="m3 8 3 3 7-7"/>' : '<path d="M8 3v6m0 3v.25"/>';
      button.title = status.textContent = success ? '刷新成功' : '刷新失败，点击重试';
      resetTimer = setTimeout(reset, success ? 1200 : 2400);
    }
  };
}

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
  const key = wasFocused && ['id', 'data-date', 'data-period', 'data-heat-page', 'data-remove', 'data-go', 'data-clear']
    .find((name) => active.hasAttribute(name));
  const value = key && active.getAttribute(key);
  root.innerHTML = html;
  renderedContent.set(root, html);
  if (!wasFocused) return;
  const match = key && [...root.querySelectorAll(`[${key}]`)].find((element) => !element.disabled && element.getAttribute(key) === value);
  const next = match || fallback?.();
  if (next?.matches('.heat-cell')) setHeatmapFocus(next);
  next?.focus({ preventScroll: true });
}
