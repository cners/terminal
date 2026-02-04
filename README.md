# Youyou

Mac 上的终端程序，功能与系统终端一致（基于 **Electron + xterm.js + node-pty**，与 VS Code 内置终端同方案）。支持：

- **自定义窗口标题**：启动时通过参数指定，或在 shell 内用 OSC 序列修改并同步到窗口
- **自定义颜色**：启动时通过参数指定背景色、前景色

## 安装与运行

```bash
# 需要 Python 3.11（node-gyp 依赖 distutils）
brew install python@3.11

# 安装依赖（若 Electron 下载很慢，可设置 ELECTRON_MIRROR 或使用 pnpm install --ignore-scripts 后单独执行 node node_modules/electron/install.js）
pnpm install

# 为当前 Electron 版本重新编译 node-pty（必须执行一次）
# 关键：让 node-gyp 使用 Python 3.11，否则会报 "No module named 'distutils'"
PYTHON="$(brew --prefix python@3.11)/bin/python3.11" pnpm run rebuild

# 启动
pnpm start
```

## 通过命令唤起并指定标题、颜色

在 **终端** 里用 `open` 打开本应用，并传参：

```bash
# 指定窗口标题
open -a Youyou --args --title "我的开发终端"

# 指定背景色、前景色（支持 #hex、rgb、颜色名）
open -a Youyou --args --title "深色终端" --bg "#0d1117" --fg "#c9d1d9"

# 打包成 .app 后，用 -a 指定应用名（默认可能是 Electron 或你在 package.json 里配置的 name）
```

若直接运行二进制（开发时或打包后的 .app 内容）：

```bash
/Applications/Youyou.app/Contents/MacOS/Youyou --title "Dev" --bg "#1a1a2e" --fg "#eaeaea"
```

**参数说明：**

| 参数 | 说明 | 示例 |
|------|------|------|
| `--title` | 窗口标题 | `--title "后端服务"` |
| `--bg` | 终端背景色 | `--bg "#1e1e1e"` |
| `--fg` | 终端前景色 | `--fg "#cccccc"` |
| `--bash` | 启动后在终端内执行命令（可多次或包含换行） | `--bash "npm i"` |

**执行脚本示例：**

```bash
# 单行命令
open -a Youyou --args --bash "agent"

# 多行脚本（方式一：多次 --bash）
open -a Youyou --args \
  --bash "cd /Users/me/project" \
  --bash "export FOO=bar" \
  --bash "agent"

# 多行脚本（方式二：使用 $'...' 传入换行）
open -a Youyou --args \
  --bash $'cd /Users/me/project\nexport FOO=bar\nagent'
```

## 在 Shell 内修改窗口标题

终端已支持 **OSC 标题**：当 shell 或程序输出设置标题的转义序列时，窗口标题会同步更新。例如：

```bash
# Bash/Zsh
echo -e '\033]0;新标题\007'

# 或
printf '\033]0;%s\007' "新标题"
```

这样窗口标题会变为「新标题」。

## 常见日志说明

- **`error messaging the mach port for IMKCFRunLoopWakeUpReliable`**：macOS 输入法相关系统日志，可忽略，不影响使用。
- 若窗口内出现红字「渲染脚本报错: ...」，请根据具体报错内容排查（如 Terminal/FitAddon 未注入、或缺少依赖等）。

## 技术说明

- **主进程**（`main.js`）：解析 `process.argv` 中的 `--title` / `--bg` / `--fg`，创建 `BrowserWindow` 并设置标题与 `backgroundColor`；使用 `node-pty` 启动系统 shell（`$SHELL` 或 zsh），通过 IPC 与渲染进程收发数据与 resize。
- **渲染进程**（`src/renderer/renderer.js`）：使用 **xterm.js** + **FitAddon** 渲染终端；接收主进程发来的 PTY 输出、发送用户输入与 resize；监听 xterm 的 `onTitleChange`，将 shell 内设置的标题同步到窗口（`terminal.setTitle`）。
- **preload**（`preload.js`）：通过 `contextBridge` 暴露 `terminal.*` API，供渲染进程安全调用 IPC。

## 打包为 .app（可选）

```bash
pnpm add -g electron-builder
# 在 package.json 中配置 build 后：
pnpm exec electron-builder --mac
```

打包后应用名会由 `productName` 或 `name` 决定，`open -a <应用名> --args ...` 中的「应用名」需与之一致。
