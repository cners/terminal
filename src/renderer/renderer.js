/**
 * 渲染进程：xterm.js 终端 + FitAddon，与主进程 IPC 通信
 */
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

if (!window.terminal) {
  showError('未检测到 terminal API，请检查 preload 是否正常加载。');
  throw new Error('window.terminal is undefined');
}

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

const container = document.getElementById('terminal-container');
container.textContent = ''; // 清掉「加载中…」

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
  // 布局稳定后再 fit 一次，避免首帧尺寸为 0 导致看不见
  requestAnimationFrame(() => {
    requestAnimationFrame(() => fitAddon.fit());
  });

  // 应用启动参数传入的主题色（主进程会发 terminal-theme）
  window.terminal.onTheme((theme) => {
    applyThemeVars(theme);
    terminal.options.theme = {
      ...terminal.options.theme,
      background: theme.bg,
      foreground: theme.fg,
    };
  });

  // 若先收到 theme 再打开，上面已处理；getTheme 用于异步拿到后备
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

  // 主进程发来的 PTY 输出
  window.terminal.onData((data) => terminal.write(data));

  // shell 内改标题（如 echo -e '\033]0;NewTitle\007'）同步到窗口
  terminal.onTitleChange((title) => {
    if (window.terminal.setTitle) window.terminal.setTitle(title);
  });

  // 用户输入 -> 主进程 -> PTY
  terminal.onData((input) => window.terminal.sendInput(input));

  // 窗口或容器尺寸变化时同步到 PTY
  terminal.onResize(({ cols, rows }) => window.terminal.sendResize(cols, rows));

  const resizeObserver = new ResizeObserver(() => fitAddon.fit());
  resizeObserver.observe(container);

  window.terminal.onExit((code) => {
    terminal.writeln(`\r\n进程已退出，退出码: ${code}`);
  });

  terminal.focus();
} catch (err) {
  showError('终端初始化失败: ' + (err.message || String(err)));
}
