// modern-monaco deduce el lenguaje por la URI. Sincronizamos el modo del editor
// para poder conservar el modelo y su historial al cambiar entre JS y TS.
function replaceRequired(source, original, replacement) {
  if (!source.includes(original)) {
    throw new Error('modern-monaco changed: review the language-mode adapter')
  }
  return source.replace(original, replacement)
}

export function patchLanguageSetup(source) {
  return replaceRequired(
    source,
    '  return worker2;\n}',
    `
  const syncResources = worker2.withSyncedResources.bind(worker2);
  worker2.withSyncedResources = async (resources) => {
    const proxy = await syncResources(resources);
    const modes = monaco.editor.getModels().map((model) => [
      model.uri.toString(), model.getLanguageId()
    ]);
    await proxy.setLanguageModes(modes);
    return proxy;
  };
  return worker2;
}`,
  )
}

export function patchLanguageWorker(source) {
  source = replaceRequired(
    source,
    '  getScriptFileNames() {',
    `
  _languageModes = new Map();
  setLanguageModes(modes) {
    this._languageModes = new Map(modes);
  }
  getScriptKind(fileName) {
    const language = this._languageModes.get(fileName);
    if (language === 'javascript') return ts.ScriptKind.JS;
    if (language === 'typescript') return ts.ScriptKind.TS;
    return ts.getScriptKindFromFileName(fileName);
  }
  getScriptFileNames() {`,
  )
  source = replaceRequired(
    source,
    'return this.#importMapVersion + "." + model.version;',
    'return this.#importMapVersion + "." + this.getScriptKind(fileName) + "." + model.version;',
  )
  return replaceRequired(
    source,
    'if (ext === ".tsx" || ext?.endsWith("ts")) {',
    'if (this.getScriptKind(uri) === ts.ScriptKind.TS || this.getScriptKind(uri) === ts.ScriptKind.TSX) {',
  )
}
