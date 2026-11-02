import { describe, expect, it } from 'vitest'
import setupSource from '/node_modules/modern-monaco/dist/lsp/typescript/setup.mjs?raw'
import workerSource from '/node_modules/modern-monaco/dist/lsp/typescript/worker.mjs?raw'
import { patchLanguageSetup, patchLanguageWorker } from './monaco-language-mode.mjs'

describe('modern-monaco language mode patches', () => {
  it('patches the installed TypeScript worker exactly where expected', () => {
    const patched = patchLanguageWorker(workerSource)

    expect(patched).toContain('setLanguageModes(modes) {')
    expect(patched).toContain('getScriptKind(fileName) {')
    expect(patched).toContain('this.getScriptKind(fileName) + "." + model.version')
    expect(patched).toContain('const scriptKind = this.getScriptKind(uri);')
    expect(patched).not.toContain('if (ext === ".tsx" || ext?.endsWith("ts")) {')
  })

  it('syncs language modes on model events instead of on every request', () => {
    const patched = patchLanguageSetup(setupSource)

    expect(patched).toContain('monaco.editor.onDidChangeModelLanguage(({ model }) => gojsSyncLanguageModesSafely(model));')
    expect(patched).toContain('monaco.editor.onDidCreateModel(() => gojsSyncLanguageModesSafely());')
    expect(patched).not.toContain('worker2.withSyncedResources =')
    // The original command that served as the anchor is still there, once.
    expect(patched.split('id: "ts:fetch_http_module"').length - 1).toBe(1)
  })

  it('fails loudly when modern-monaco changes', () => {
    expect(() => patchLanguageWorker('export {}')).toThrow(/modern-monaco changed/)
    expect(() => patchLanguageSetup(setupSource + setupSource)).toThrow(/found 2/)
  })
})
