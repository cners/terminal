/**
 * Youyou - Electron 主进程
 * 功能：与系统终端一致的 PTY 终端；支持 --title / --bg / --fg 命令行参数自定义窗口标题与颜色
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const windows = new Map();
const ptys = new Map();
const windowThemes = new Map();

/** 从 argv 解析用户传入的 --key value 参数（Electron 会追加很多参数，我们只取 --title/--bg/--fg/--bash） */
function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : process.argv;
  const out = {
    baseTitle: '柚柚来喽~',
    userTitle: '',
    bg: '#1e1e1e',
    fg: '#cccccc',
    bashLines: [],
  };
  const decodeBashArg = (value) => {
    if (!value) return '';
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  };
  const pushBash = (value) => {
    const decoded = decodeBashArg(value);
    if (!decoded) return;
    const lines = decoded.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.length > 0);
    out.bashLines.push(...lines);
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title' && args[i + 1]) {
      out.userTitle = args[i + 1];
      i++;
    } else if (args[i] === '--bg' && args[i + 1]) {
      out.bg = args[i + 1];
      i++;
    } else if (args[i] === '--fg' && args[i + 1]) {
      out.fg = args[i + 1];
      i++;
    } else if (args[i] === '--bash' && args[i + 1]) {
      pushBash(args[i + 1]);
      i++;
    }
  }
  return out;
}

function buildWindowTitle(baseTitle, userTitle) {
  const suffix = (userTitle || '').trim();
  return suffix ? `${baseTitle} ${suffix}` : baseTitle;
}

/** 返回首个存在的 shell 路径，避免 posix_spawnp 因路径无效失败 */
function getShell() {
  if (os.platform() === 'win32') return 'powershell.exe';
  const candidates = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { }
  }
  return '/bin/zsh';
}

/** 为 PTY 构建环境；从 Finder 启动时用最小 env，从终端启动时尽量继承 process.env */
function getPtyEnv() {
  const home = os.homedir();
  if (os.platform() === 'win32') {
    return { ...process.env, HOME: process.env.HOME || home };
  }
  const cwd = home || process.cwd();
  // 常见开发工具路径：Homebrew (Apple Silicon & Intel), Go, Rust, Node (nvm/fnm), Python, etc.
  const commonPaths = [
    '/opt/homebrew/bin',           // Homebrew (Apple Silicon)
    '/opt/homebrew/sbin',
    '/usr/local/go/bin',           // Go 官方安装路径
    `${home}/go/bin`,              // Go workspace bin
    `${home}/.cargo/bin`,          // Rust
    `${home}/.nvm/versions/node/*/bin`, // nvm (会被 shell 展开)
    `${home}/.local/bin`,          // pipx, poetry 等
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  const base = {
    HOME: home,
    USER: process.env.USER || (os.userInfo && os.userInfo().username) || 'user',
    PATH: commonPaths,
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PWD: cwd,
    GOPATH: `${home}/go`,          // Go 默认 GOPATH
  };
  if (process.env.SHELL && process.env.PWD && !app.isPackaged) {
    try {
      return { ...process.env, PWD: cwd };
    } catch (_) { }
  }
  return base;
}

function createWindow(argv) {
  const { baseTitle, userTitle, bg, fg, bashLines } = parseArgv(argv);
  const title = buildWindowTitle(baseTitle, userTitle);
  const isMac = process.platform === 'darwin';
  const titlebarHeight = 36;
  const titlebarOffsetY = 3;
  const trafficLightSize = 12;
  const trafficLightY = Math.round(titlebarOffsetY + (titlebarHeight - trafficLightSize) / 2);

  if (isMac && !app.isPackaged) {
    const iconPath = path.join(__dirname, 'assets', 'terminal-youyou.png');
    if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath);
  }

  const windowOpts = {
    width: 900,
    height: 600,
    title,
    backgroundColor: bg,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: true,
    },
  };

  if (isMac) {
    windowOpts.titleBarStyle = 'hiddenInset';
    windowOpts.trafficLightPosition = { x: 14, y: trafficLightY };
  }

  const win = new BrowserWindow(windowOpts);
  windows.set(win.id, win);
  windowThemes.set(win.id, { baseTitle, userTitle, bg, fg });

  win.on('focus', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('window-active', true);
  });

  win.on('blur', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('window-active', false);
  });

  win.setTitle(title);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('terminal-theme', { bg, fg, baseTitle, userTitle, title });
    win.webContents.send('window-active', win.isFocused());
    setTimeout(() => spawnPty(win, { bashLines }), 150);
  });

  win.on('closed', () => {
    const pty = ptys.get(win.id);
    if (pty) {
      pty.kill();
      ptys.delete(win.id);
    }
    windowThemes.delete(win.id);
    windows.delete(win.id);
  });

  return win;
}

function spawnPty(win, options = {}) {
  if (!win || win.isDestroyed()) return;
  const pty = require('node-pty');
  const cols = 80;
  const rows = 24;
  const cwd = os.homedir() || process.cwd();
  const env = getPtyEnv();
  const shells = [getShell(), '/bin/bash', '/bin/sh'].filter((p, i, a) => a.indexOf(p) === i);

  let ptyProcess = null;
  for (const shell of shells) {
    try {
      ptyProcess = pty.spawn(shell, ['-i'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
      break;
    } catch (err) {
      ptyProcess = null;
      if (shell === shells[shells.length - 1]) {
        const msg = `PTY 启动失败: ${err.message}\n\n请从终端启动: pnpm start -- --title "Dev" --bg "#1a1a2e"`;
        if (!win.isDestroyed()) {
          win.webContents.send('terminal-data', '\r\n\x1b[31m' + msg + '\x1b[0m\r\n');
        }
        return;
      }
    }
  }
  if (!ptyProcess) return;
  ptys.set(win.id, ptyProcess);
  const bashLines = Array.isArray(options.bashLines) ? options.bashLines.filter(Boolean) : [];
  let bashSent = false;
  let bashScheduled = false;
  const sendBash = () => {
    if (bashSent || bashLines.length === 0 || !ptyProcess) return;
    bashSent = true;
    for (const line of bashLines) {
      if (line && ptyProcess) ptyProcess.write(line + '\r');
    }
  };
  const scheduleBash = () => {
    if (bashScheduled || bashSent || bashLines.length === 0) return;
    bashScheduled = true;
    setTimeout(sendBash, 160);
  };

  ptyProcess.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal-data', data);
    }
    scheduleBash();
  });

  if (bashLines.length > 0) {
    setTimeout(sendBash, 100);
  }

  ptyProcess.onExit(({ exitCode }) => {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal-exit', exitCode);
    }
    ptys.delete(win.id);
  });
}

// 关闭沙箱以便 node-pty 能正常 spawn shell（macOS 下 posix_spawnp 在沙箱内常失败）
app.commandLine.appendSwitch('no-sandbox');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    const win = createWindow(argv);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      credits: '技术支持：壮壮\n联系方式：liuzhuangs@hotmail.com',
    });
    createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 单实例锁下，second-instance 用于开新窗口并解析 argv 传参

// --------------- IPC ---------------
ipcMain.on('terminal-input', (_, data) => {
  const win = BrowserWindow.fromWebContents(_.sender);
  if (!win) return;
  const pty = ptys.get(win.id);
  if (pty) pty.write(data);
});

ipcMain.on('terminal-resize', (_, { cols, rows }) => {
  const win = BrowserWindow.fromWebContents(_.sender);
  if (!win) return;
  const pty = ptys.get(win.id);
  if (pty) pty.resize(cols, rows);
});

ipcMain.on('terminal-set-title', (_, title) => {
  const win = BrowserWindow.fromWebContents(_.sender);
  if (win && !win.isDestroyed()) win.setTitle(title);
});

ipcMain.handle('terminal-get-theme', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return parseArgv();
  return windowThemes.get(win.id) || parseArgv();
});

ipcMain.on('window-new', (_, argv) => {
  const win = createWindow(argv);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
