function createAppearance(onChange) {
  const key = 'agy-liquid-monitor.appearance.v1';
  const defaults = { theme: 'auto', opacity: 58, blurStrength: 40 };
  const themes = { auto: '跟随 Antigravity', light: '白天', dark: '黑夜', pink: '粉色', green: '绿色' };
  const bounded = (value, min, max, fallback) =>
    Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
  let settings = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved) settings = {
      theme: Object.hasOwn(themes, saved.theme) ? saved.theme : defaults.theme,
      opacity: bounded(saved.opacity, 35, 100, defaults.opacity),
      blurStrength: bounded(saved.blurStrength ?? (Number.isFinite(saved.blur) ? saved.blur * 2.5 : null),
        0, 100, defaults.blurStrength)
    };
  } catch {
    // Some embedded views disable local storage.
  }

  const icon = '<path d="M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M6 10.5v3"/>';
  const markup = `<div class="appearance-settings">
    <div class="appearance-row"><span>主题</span>
      <details class="appearance-theme"><summary><span class="visually-hidden">主题：</span><span data-current-theme></span>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></summary>
        <div class="appearance-options" role="group" aria-label="主题选项">
          ${Object.entries(themes).map(([value, label]) =>
            `<label><input type="radio" name="theme" value="${value}"><span>${label}</span></label>`).join('')}
        </div>
      </details>
    </div>
    <label class="appearance-row"><span>玻璃透明度</span><output data-output="opacity"></output>
      <input name="opacity" aria-label="玻璃透明度" type="range" min="0" max="65" step="1"></label>
    <label class="appearance-row"><span>模糊强度</span><output data-output="blur"></output>
      <input name="blur" aria-label="模糊强度" type="range" min="0" max="100" step="1"></label>
    <button class="subtle-button appearance-reset" type="button">恢复默认</button>
  </div>`;

  function apply(element, hostTheme) {
    const theme = settings.theme;
    const brightness = theme === 'light' || theme === 'dark' ? theme : hostTheme;
    const palette = theme === 'pink' || theme === 'green' ? theme : 'neutral';
    if (element.dataset.theme !== brightness) element.dataset.theme = brightness;
    if (element.dataset.palette !== palette) element.dataset.palette = palette;
    const opacity = `${settings.opacity}%`;
    // Keep small adjustments visible before the backdrop loses most of its detail.
    const blur = `${(20 * (settings.blurStrength / 100) ** 3).toFixed(2)}px`;
    if (element.style.getPropertyValue('--glass-opacity') !== opacity) element.style.setProperty('--glass-opacity', opacity);
    if (element.style.getPropertyValue('--glass-blur') !== blur) element.style.setProperty('--glass-blur', blur);
  }

  function bind(root) {
    const theme = root.querySelector('.appearance-theme');
    const radios = theme.querySelectorAll('[name="theme"]');
    const opacity = root.querySelector('[name="opacity"]');
    const blur = root.querySelector('[name="blur"]');
    function sync() {
      theme.querySelector('[data-current-theme]').textContent = themes[settings.theme];
      for (const radio of radios) radio.checked = radio.value === settings.theme;
      opacity.value = 100 - settings.opacity;
      blur.value = settings.blurStrength;
      root.querySelector('[data-output="opacity"]').value = `${opacity.value}%`;
      root.querySelector('[data-output="blur"]').value = `${blur.value}%`;
    }
    function update() {
      sync();
      try { localStorage.setItem(key, JSON.stringify(settings)); } catch {}
      onChange();
    }
    theme.addEventListener('change', (event) => {
      settings.theme = event.target.value;
      update();
    });
    theme.addEventListener('click', (event) => {
      if (!event.detail || !event.target.matches('[name="theme"]')) return;
      theme.open = false;
      theme.querySelector('summary').focus({ preventScroll: true });
    });
    opacity.addEventListener('input', () => { settings.opacity = 100 - opacity.valueAsNumber; update(); });
    blur.addEventListener('input', () => { settings.blurStrength = blur.valueAsNumber; update(); });
    root.querySelector('.appearance-reset').addEventListener('click', () => { settings = { ...defaults }; update(); });
    sync();
  }

  function closeThemeMenu(root) {
    const theme = root.querySelector('.appearance-theme[open]');
    if (!theme) return false;
    theme.open = false;
    theme.querySelector('summary').focus({ preventScroll: true });
    return true;
  }
  return { apply, bind, closeThemeMenu, icon, markup };
}
