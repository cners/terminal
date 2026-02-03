/**
 * 预加载脚本：暴露 IPC API，并在 DOMContentLoaded 后在同一上下文里创建终端（保证有 require 且 window.terminal 已存在）
 */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const terminalAPI = {
  onData: (cb) => {
    ipcRenderer.on('terminal-data', (_, data) => cb(data));
  },
  onExit: (cb) => {
    ipcRenderer.on('terminal-exit', (_, code) => cb(code));
  },
  onTheme: (cb) => {
    ipcRenderer.on('terminal-theme', (_, theme) => cb(theme));
  },
  onWindowActive: (cb) => {
    ipcRenderer.on('window-active', (_, active) => cb(active));
  },
  sendInput: (data) => ipcRenderer.send('terminal-input', data),
  sendResize: (cols, rows) => ipcRenderer.send('terminal-resize', { cols, rows }),
  setTitle: (title) => ipcRenderer.send('terminal-set-title', title),
  openNewWindow: (argv) => ipcRenderer.send('window-new', argv),
  getTheme: () => ipcRenderer.invoke('terminal-get-theme'),
};

contextBridge.exposeInMainWorld('terminal', terminalAPI);
window.terminal = terminalAPI;

function applyThemeVars(theme) {
  if (!theme) return;
  const bg = theme.bg;
  if (bg) {
    document.documentElement.style.setProperty('--term-bg', bg);
    document.body.style.background = bg;
  }
  const baseTitle = theme.baseTitle || '柚柚来喽~';
  const userTitle = (theme.userTitle || '').trim();
  const baseEl = document.getElementById('titlebar-title-base');
  const suffixEl = document.getElementById('titlebar-title-suffix');
  if (baseEl) baseEl.textContent = baseTitle;
  if (suffixEl) suffixEl.textContent = userTitle;
  applySavedTitleColor(userTitle);
  applySavedDraftText();
}

let currentTitleKey = null;
function computeTitleKey(userTitle) {
  const title = (userTitle || '').trim();
  if (!title) return null;
  return crypto.createHash('md5').update(title).digest('hex');
}

function applySavedTitleColor(userTitle) {
  currentTitleKey = computeTitleKey(userTitle);
  if (!currentTitleKey) return;
  const saved = localStorage.getItem(`title-color:${currentTitleKey}`);
  if (!saved) return;
  document.documentElement.style.setProperty('--title-suffix-color', saved);
  const input = document.getElementById('titlebar-color');
  if (input) input.value = saved;
}

function saveTitleColor(value) {
  if (!currentTitleKey) return;
  localStorage.setItem(`title-color:${currentTitleKey}`, value);
}

function getDraftKey() {
  return currentTitleKey ? `draft-current:${currentTitleKey}` : null;
}

function getDraftArchiveKey() {
  return currentTitleKey ? `draft-archive:${currentTitleKey}` : null;
}

function loadDraftArchive() {
  const key = getDraftArchiveKey();
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item) => item && typeof item.text === 'string') : [];
  } catch (_) {
    return [];
  }
}

function applySavedDraftText() {
  const textarea = document.getElementById('draft-textarea');
  const key = getDraftKey();
  if (!textarea || !key) return;
  const saved = localStorage.getItem(key);
  if (saved !== null) {
    textarea.value = saved;
    return;
  }
  const archive = loadDraftArchive();
  if (archive.length > 0) {
    textarea.value = archive[archive.length - 1].text || '';
  }
}

function saveDraftText(value) {
  const key = getDraftKey();
  if (!key) return;
  localStorage.setItem(key, value || '');
}

function archiveDraftText(value) {
  const key = getDraftArchiveKey();
  if (!key) return;
  const text = (value || '').trim();
  if (!text) return;
  const list = loadDraftArchive();
  list.push({ ts: Date.now(), text });
  if (list.length > 50) list.splice(0, list.length - 50);
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch (_) {}
}

function initTitlebarControls() {
  const input = document.getElementById('titlebar-color');
  if (!input) return;
  const root = document.documentElement;
  const current = getComputedStyle(root).getPropertyValue('--title-suffix-color').trim();
  if (current) input.value = current;
  input.addEventListener('input', (e) => {
    const value = e.target.value;
    if (value) root.style.setProperty('--title-suffix-color', value);
    if (value) saveTitleColor(value);
  });
}

function initDraftPanel() {
  const btn = document.getElementById('titlebar-draft-btn');
  const panel = document.getElementById('draft-panel');
  const closeBtn = document.getElementById('draft-close-btn');
  const copyBtn = document.getElementById('draft-copy-btn');
  const textarea = document.getElementById('draft-textarea');
  const resizeHandle = document.getElementById('draft-resize');
  const toast = document.getElementById('toast');
  if (!btn || !panel || !closeBtn || !copyBtn || !textarea) return;
  const root = document.documentElement;
  let toastTimer = null;

  const showToast = (msg) => {
    if (!toast) return;
    toast.textContent = msg || '已复制';
    document.body.classList.add('toast-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      document.body.classList.remove('toast-show');
    }, 1200);
  };
  const updateCopyVisibility = () => {
    const hasText = (textarea.value || '').trim().length > 0;
    copyBtn.style.display = hasText ? 'inline-flex' : 'none';
  };

  const updatePanelHeight = () => {
    const open = document.body.classList.contains('draft-open');
    const height = open ? Math.round(panel.getBoundingClientRect().height) : 0;
    root.style.setProperty('--draft-panel-h', `${height}px`);
  };
  const ro = new ResizeObserver(updatePanelHeight);
  ro.observe(panel);

  const openPanel = () => {
    document.body.classList.add('draft-open');
    requestAnimationFrame(() => {
      applySavedDraftText();
      updatePanelHeight();
      updateCopyVisibility();
      textarea.focus();
    });
  };
  const closePanel = () => {
    archiveDraftText(textarea.value);
    saveDraftText(textarea.value);
    document.body.classList.remove('draft-open');
    updatePanelHeight();
  };
  const togglePanel = () => {
    if (document.body.classList.contains('draft-open')) closePanel();
    else openPanel();
  };

  btn.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', closePanel);
  textarea.addEventListener('input', () => {
    saveDraftText(textarea.value);
    updateCopyVisibility();
  });
  copyBtn.addEventListener('click', async () => {
    const text = textarea.value || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制');
    } catch (_) {
      textarea.select();
      document.execCommand('copy');
      textarea.setSelectionRange(text.length, text.length);
      showToast('已复制');
    }
  });

  if (resizeHandle) {
    let dragging = false;
    let startY = 0;
    let startH = 0;
    const getPx = (value) => Number(String(value || '0').replace('px', '')) || 0;
    const getMaxTextHeight = () => {
      const maxPanel = getPx(getComputedStyle(root).getPropertyValue('--draft-panel-max-h'));
      const header = document.getElementById('draft-panel-header');
      const headerH = header ? header.getBoundingClientRect().height : 32;
      const handleH = resizeHandle.getBoundingClientRect().height || 8;
      if (!maxPanel) return Infinity;
      return Math.max(80, maxPanel - headerH - handleH - 8);
    };
    const getMinTextHeight = () => {
      const min = getPx(getComputedStyle(textarea).minHeight);
      return min || textarea.getBoundingClientRect().height;
    };
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    resizeHandle.addEventListener('mousedown', (e) => {
      if (!document.body.classList.contains('draft-open')) return;
      dragging = true;
      startY = e.clientY;
      startH = textarea.getBoundingClientRect().height;
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientY - startY;
      const next = clamp(startH + delta, getMinTextHeight(), getMaxTextHeight());
      textarea.style.height = `${Math.round(next)}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
    });
  }

  updatePanelHeight();
  applySavedDraftText();
  updateCopyVisibility();
}

function initWindowControls() {
  const btn = document.getElementById('titlebar-new-btn');
  if (!btn || !window.terminal?.openNewWindow) return;
  btn.addEventListener('click', () => window.terminal.openNewWindow());
}

function showError(msg) {
  const el = document.getElementById('terminal-container');
  if (el) {
    el.innerHTML = '';
    const p = document.createElement('p');
    p.style.cssText = 'color:#f44;padding:1em;font-family:monospace;';
    p.textContent = msg;
    el.appendChild(p);
  }
}

function initTerminal() {
  const container = document.getElementById('terminal-container');
  if (!container) return;
  container.textContent = '';

  let terminal;
  try {
    const { Terminal } = require('@xterm/xterm');
    const { FitAddon } = require('@xterm/addon-fit');

    terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      scrollback: 10000,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        cursorAccent: '#000000',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });

    window.terminal.onTheme((theme) => {
      applyThemeVars(theme);
      terminal.options.theme = {
        ...terminal.options.theme,
        background: theme.bg,
        foreground: theme.fg,
      };
    });

    window.terminal.onWindowActive?.((active) => {
      document.body.classList.toggle('window-inactive', !active);
    });

    window.terminal.getTheme?.().then((theme) => {
      if (theme && (theme.bg || theme.fg)) {
        applyThemeVars(theme);
        terminal.options.theme = {
          ...terminal.options.theme,
          background: theme.bg || terminal.options.theme?.background,
          foreground: theme.fg || terminal.options.theme?.foreground,
        };
      }
    }).catch(() => {});

    window.terminal.onData((data) => terminal.write(data));
    terminal.onTitleChange((title) => {
      if (window.terminal.setTitle) window.terminal.setTitle(title);
    });
    terminal.onData((input) => window.terminal.sendInput(input));
    terminal.onResize(({ cols, rows }) => window.terminal.sendResize(cols, rows));

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(container);

    window.terminal.onExit((code) => {
      terminal.writeln('\r\n进程已退出，退出码: ' + code);
    });

    terminal.focus();
  } catch (err) {
    showError('终端初始化失败: ' + (err.message || String(err)));
  }
}

function injectXtermCss() {
  try {
    const xtermPkgDir = path.dirname(path.dirname(require.resolve('@xterm/xterm')));
    const xtermCssPath = path.join(xtermPkgDir, 'css', 'xterm.css');
    const css = fs.readFileSync(xtermCssPath, 'utf8');
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  } catch (_) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    injectXtermCss();
    initTitlebarControls();
    initDraftPanel();
    initWindowControls();
    initTerminal();
  });
} else {
  injectXtermCss();
  initTitlebarControls();
  initDraftPanel();
  initWindowControls();
  initTerminal();
}
