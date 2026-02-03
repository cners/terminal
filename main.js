/**
 * youyou_terminal - Electron 主进程
 * 功能：与系统终端一致的 PTY 终端；支持 --title / --bg / --fg 命令行参数自定义窗口标题与颜色
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow = null;
let ptyProcess = null;

/** 从 argv 解析用户传入的 --key value 参数（Electron 会追加很多参数，我们只取 --title/--bg/--fg） */
function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : process.argv;
  const out = {
    baseTitle: '柚柚来喽~',
    userTitle: '',
    bg: '#1e1e1e',
    fg: '#cccccc',
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
    } catch (_) {}
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
  const base = {
    HOME: home,
    USER: process.env.USER || (os.userInfo && os.userInfo().username) || 'user',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'en_US.UTF-8',
    PWD: cwd,
  };
  if (process.env.SHELL && process.env.PWD && !app.isPackaged) {
    try {
      return { ...process.env, PWD: cwd };
    } catch (_) {}
  }
  return base;
}

function applyArgs(argv) {
  const { baseTitle, userTitle, bg, fg } = parseArgv(argv);
  const title = buildWindowTitle(baseTitle, userTitle);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title);
    mainWindow.setBackgroundColor(bg);
    mainWindow.webContents.send('terminal-theme', { bg, fg, baseTitle, userTitle, title });
  }
  return { baseTitle, userTitle, bg, fg };
}

function createWindow() {
  const { baseTitle, userTitle, bg, fg } = parseArgv();
  const title = buildWindowTitle(baseTitle, userTitle);
  const isMac = process.platform === 'darwin';

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
    windowOpts.trafficLightPosition = { x: 14, y: 12 };
  }

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.on('focus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window-active', true);
  });

  mainWindow.on('blur', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window-active', false);
  });

  mainWindow.setTitle(title);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('terminal-theme', { bg, fg, baseTitle, userTitle, title });
    mainWindow.webContents.send('window-active', mainWindow.isFocused());
    setTimeout(() => spawnPty(), 150);
  });

  mainWindow.on('closed', () => {
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
    mainWindow = null;
  });
}

function spawnPty() {
  const pty = require('node-pty');
  const cols = 80;
  const rows = 24;
  const cwd = os.homedir() || process.cwd();
  const env = getPtyEnv();
  const shells = [getShell(), '/bin/bash', '/bin/sh'].filter((p, i, a) => a.indexOf(p) === i);

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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-data', '\r\n\x1b[31m' + msg + '\x1b[0m\r\n');
        }
        return;
      }
    }
  }
  if (!ptyProcess) return;

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit', exitCode);
    }
    ptyProcess = null;
  });
}

// 关闭沙箱以便 node-pty 能正常 spawn shell（macOS 下 posix_spawnp 在沙箱内常失败）
app.commandLine.appendSwitch('no-sandbox');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else {
      applyArgs(argv);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 单实例时，再次用 open -a 带参数打开，可考虑打开新窗口并传参；这里保持简单，只处理首次启动参数
// 若需多窗口，可监听 second-instance 并解析 argv 再 createWindow

// --------------- IPC ---------------
ipcMain.on('terminal-input', (_, data) => {
  if (ptyProcess) ptyProcess.write(data);
});

ipcMain.on('terminal-resize', (_, { cols, rows }) => {
  if (ptyProcess) ptyProcess.resize(cols, rows);
});

ipcMain.on('terminal-set-title', (_, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(title);
});

ipcMain.handle('terminal-get-theme', () => parseArgv());
