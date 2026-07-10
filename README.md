# GoJS ⚡

A fast, interactive JavaScript and TypeScript playground built for instant experimentation.

## 🚀 Features

- ✨ **Modern Monaco editor** - Powered by `modern-monaco` with syntax highlighting
- 🎯 **Real-time execution** - Automatically runs JavaScript/TypeScript as you type
- ⚡ **Smart auto-run** - Uses an 800ms debounce to prevent excessive executions and can be enabled or disabled
- 📝 **TypeScript validation** - JavaScript type checking with `checkJs` enabled
- 🎨 **Modern interface** - Clean, responsive UI with a dark theme
- ⌨️ **Keyboard shortcuts** - `Cmd+Enter` / `Ctrl+Enter` to run and `Cmd+Shift+F` to format
- 📊 **Advanced console** - Full support for log, info, warn, error, `console.time()`/`console.timeEnd()`, `console.table()`, and `console.count()`
- 🔍 **Smart navigation** - Hover over logs to highlight lines and click to jump to the code
- 📍 **Line numbers** - Each log shows the exact line that generated it
- ⏱️ **Time measurement** - Special display for `console.time()`/`console.timeEnd()`
- 🔄 **Resizable panel** - Adjust the size of the editor and console
- 🔧 **Automatic formatting** - Formats code while typing and when pasting
- 🟢 **Native Node.js runtime (desktop)** - Runs your code against a **real Node.js 26 runtime** embedded in the app, with native `npm install`, full standard library access, and native module support

## 🖥️ Desktop app and native Node.js runtime

In the desktop version (Tauri), GoJS can run your code in two ways. Switch between them using the runtime button in the header or under **Settings → Runtime**:

- **Browser sandbox** (default): An isolated Web Worker that works anywhere.
- **Node.js (native)**: Launches an embedded **Node.js 26** process. Code runs as it would in a real Node.js project, so you can `import` npm packages, use the file system, and more.

Dependencies are managed under **Settings → Runtime → Dependencies**, where you can install, update, and remove packages using native `npm`. They live in a per-user workspace (`<app_data>/workspace`), so your code can import them just like in any Node.js project.

### Building the desktop app

The Node.js runtime is downloaded and bundled as a Tauri resource:

```bash
# Download Node.js 26 for your platform into src-tauri/runtime (once)
pnpm node:fetch

# Development (falls back to `node` from PATH if no runtime is embedded)
pnpm desktop:dev

# Production build (runs node:fetch automatically)
pnpm desktop:build
```

> The Node.js binary (~60–90 MB) is ignored by Git; `pnpm node:fetch` regenerates it. You can pin a version with `NODE_VERSION=vXX.Y.Z pnpm node:fetch`.

## 🛠️ Technologies

- [Vite](https://vitejs.dev/) - Blazing-fast build tool
- [modern-monaco](https://github.com/esm-dev/modern-monaco) - Modern Monaco editor
- TypeScript - Static typing
- Modern CSS - CSS variables and flexible layouts

## 📦 Installation

```bash
# Install dependencies
pnpm install

# Run in development
pnpm dev

# Build for production
pnpm build

# Preview the production build
pnpm preview
```

## 🎮 Usage

1. Write JavaScript or TypeScript code in the editor
2. Your code runs automatically as you type with an 800ms debounce
3. You can also press `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows) to run it manually
4. View the results in real time in the console
5. Disable "Auto-run" if you prefer manual execution
6. **Hover over a log** to highlight its line in the editor
7. **Click a log** to jump directly to its line and focus the editor
8. Use `console.time()` and `console.timeEnd()` to measure execution time
9. Use `console.table()` to display arrays and objects in a clean table
10. Use `console.count()` to count how many times a line runs with a specific label

## 📄 License

MIT
