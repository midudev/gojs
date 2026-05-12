# GoJS.app zero-native macOS Spike

This directory contains the zero-native shell for the existing Vite app. It is intentionally separate from the web source so the browser app can keep shipping normally while the native runtime is validated.

## Setup

From the repository root:

```bash
pnpm install
pnpm native:cef:install
```

`native/third_party/cef` is ignored because the Chromium runtime is large and platform-specific.

## Development

```bash
pnpm native:dev
```

This builds the Zig shell, starts the existing Vite dev server on `127.0.0.1:5555`, and opens the CEF-backed desktop window.

## Production Assets

```bash
pnpm build
pnpm native:run
```

The native build copies the Vite output into `native/dist` and serves it through `zero://app`.

## Packaging

```bash
pnpm native:package
```

This creates a local unsigned `.app` under `native/zig-out/package`. Signing, notarization, and DMG creation are intentionally outside this spike.

## Runtime Checklist

- Monaco loads and remains editable.
- Tabs persist through `localStorage`.
- The executor worker runs user snippets and can be terminated on timeout.
- The Prettier worker formats code.
- The GitHub issue link opens in the system browser.
- WebLLM can download a small model, cache it in `IndexedDB`, reload it, and uninstall it.

## Automated Checks

The non-interactive spike checks are:

```bash
pnpm build
cd native && pnpm exec zero-native validate app.zon
cd native && zig build -Dplatform=null -Dweb-engine=system test
cd native && zig build
pnpm native:doctor
pnpm native:package
pnpm native:run
```

`pnpm native:run` is a launch smoke test: the runtime should initialize, load `assets`, and publish at least one frame. The detailed UI checks above still need manual confirmation in the opened desktop window because Monaco, WebLLM, and editor interactions are user-visible browser behavior.

## Known Risks

- WebLLM depends on browser GPU/storage behavior and remote model hosts, so it must be tested on the target macOS/CEF runtime.
- The executor worker uses `AsyncFunction`, so adding a strict CSP later will require either `unsafe-eval` for that worker path or a different sandbox.
- Chromium/CEF gives better web-platform parity than WKWebView, but the packaged app will be substantially larger.
