// modern-monaco decides between JavaScript and TypeScript from the model URI
// extension. GoJS keeps the same model (and its undo history) when a tab
// switches language, so these patches make the TypeScript worker follow the
// model's language id instead.
//
// Every patch must match exactly once. If modern-monaco changes, the build
// fails here instead of shipping a half-patched language service.

function replaceOnce(source, original, replacement, label) {
  const matches = source.split(original).length - 1
  if (matches !== 1) {
    throw new Error(
      `modern-monaco changed (${label}: expected 1 match, found ${matches}). Review scripts/monaco-language-mode.mjs.`,
    )
  }
  // A replacer function avoids `$&`-style patterns being expanded.
  return source.replace(original, () => replacement)
}

// lsp/typescript/setup.mjs: push the language of each JS/TS model to the worker
// when a model is created or changes language, then re-run its diagnostics.
// Declaration files keep their extension-based kind, so they are skipped.
export function patchLanguageSetup(source) {
  const anchor = '  monaco.editor.addCommand({\n    id: "ts:fetch_http_module",'
  return replaceOnce(
    source,
    anchor,
    `  const gojsSyncLanguageModes = async (changedModel) => {
    const modes = monaco.editor.getModels().flatMap((model) => {
      const languageId = model.getLanguageId();
      const isScript = languageId === "javascript" || languageId === "typescript";
      return isScript && !model.uri.path.endsWith(".d.ts") ? [[model.uri.toString(), languageId]] : [];
    });
    const proxy = await worker2.getProxy();
    await proxy.setLanguageModes(modes);
    if (changedModel) {
      Reflect.get(changedModel, "refreshDiagnostics")?.();
    }
  };
  const gojsSyncLanguageModesSafely = (changedModel) => {
    gojsSyncLanguageModes(changedModel).catch((error) => {
      console.warn("[gojs] Could not sync editor language modes", error);
    });
  };
  monaco.editor.onDidCreateModel(() => gojsSyncLanguageModesSafely());
  monaco.editor.onDidChangeModelLanguage(({ model }) => gojsSyncLanguageModesSafely(model));
  gojsSyncLanguageModesSafely();
${anchor}`,
    'setup.mjs language sync',
  )
}

// lsp/typescript/worker.mjs: resolve the script kind from the synced language
// modes, include it in the script version so TypeScript re-parses the file
// when it changes, and gate semantic diagnostics on it instead of the extension.
export function patchLanguageWorker(source) {
  source = replaceOnce(
    source,
    '  getScriptFileNames() {',
    `  _languageModes = new Map();
  setLanguageModes(modes) {
    this._languageModes = new Map(modes);
  }
  getScriptKind(fileName) {
    const language = this._languageModes.get(fileName);
    if (language === "javascript") return ts.ScriptKind.JS;
    if (language === "typescript") return ts.ScriptKind.TS;
    return ts.getScriptKindFromFileName(fileName);
  }
  getScriptFileNames() {`,
    'worker.mjs host methods',
  )
  source = replaceOnce(
    source,
    'return this.#importMapVersion + "." + model.version;',
    'return this.#importMapVersion + "." + this.getScriptKind(fileName) + "." + model.version;',
    'worker.mjs script version',
  )
  return replaceOnce(
    source,
    'if (ext === ".tsx" || ext?.endsWith("ts")) {',
    `const scriptKind = this.getScriptKind(uri);
    if (scriptKind === ts.ScriptKind.TS || scriptKind === ts.ScriptKind.TSX) {`,
    'worker.mjs semantic diagnostics',
  )
}
