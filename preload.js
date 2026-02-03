/**
 * 预加载脚本：暴露 IPC API，并在 DOMContentLoaded 后在同一上下文里创建终端（保证有 require 且 window.terminal 已存在）
 */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

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
  });
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
    initTerminal();
  });
} else {
  injectXtermCss();
  initTitlebarControls();
  initTerminal();
}
