import assert from 'node:assert/strict'
import { chromium } from 'playwright'

// Ejecutar con el servidor local arrancado: node scripts/test-language-selector.mjs
const url = process.argv[2] ?? 'http://127.0.0.1:5555/app'
const browser = await chromium.launch({ headless: true })
const original = 'const age: number = 20\nconsole.log(age)'

try {
  for (const initialLanguage of ['typescript', 'javascript']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.addInitScript(
      ({ language, code }) => {
        if (sessionStorage.getItem('language-test-ready')) return
        sessionStorage.setItem('language-test-ready', 'true')
        localStorage.setItem(
          'xjs.tabs',
          JSON.stringify([
            {
              id: 'language-test',
              content: code,
              language,
              isDirty: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ]),
        )
        localStorage.setItem('xjs.activeTabId', 'language-test')
      },
      { language: initialLanguage, code: original },
    )
    const connect = async () => {
      await page.locator('.monaco-editor').first().waitFor()
      await page.evaluate(async () => {
        const resource = performance.getEntriesByType('resource').find((entry) => entry.name.includes('/src/tabs.ts'))
        window.testTabs = await import(resource.name)
      })
      await page.waitForFunction(
        () => window.testTabs.state.tabs.find((tab) => tab.id === window.testTabs.state.activeId)?.model,
      )
    }
    const selectLanguage = async (label) => {
      await page.locator('#status-language').click()
      await page.getByRole('menuitemradio', { name: label, exact: true }).click()
    }
    const checkSyntax = async (hasError) => {
      await page.waitForFunction(
        (expected) => Boolean(document.querySelector('.squiggly-error')) === expected,
        hasError,
      )
    }
    await page.goto(url)
    await connect()
    await page.evaluate(() => {
      const tabs = window.testTabs
      window.testModel = tabs.state.tabs.find((tab) => tab.id === tabs.state.activeId).model
    })
    await selectLanguage('JavaScript')
    await checkSyntax(true)
    await selectLanguage('TypeScript')
    await checkSyntax(false)

    // Crear dos grupos de edición y dejar uno pendiente de rehacer.
    await page.evaluate(async () => {
      const model = window.testModel
      const append = (text) => {
        const line = model.getLineCount()
        const column = model.getLineMaxColumn(line)
        model.pushStackElement()
        model.pushEditOperations(
          [],
          [
            {
              range: {
                startLineNumber: line,
                startColumn: column,
                endLineNumber: line,
                endColumn: column,
              },
              text,
            },
          ],
          () => null,
        )
        model.pushStackElement()
      }
      append('\n// first edit')
      append('\n// second edit')
      await model.undo()
    })
    await selectLanguage('JavaScript')
    await checkSyntax(true)
    const history = await page.evaluate(async () => {
      const tabs = window.testTabs
      const model = tabs.state.tabs.find((tab) => tab.id === tabs.state.activeId).model
      const result = { sameModel: model === window.testModel, canRedo: model.canRedo() }
      await model.redo()
      result.redone = model.getValue()
      await model.undo()
      await model.undo()
      result.undone = model.getValue()
      return result
    })
    assert.equal(history.sameModel, true)
    assert.equal(history.canRedo, true)
    assert.equal(history.redone, original + '\n// first edit\n// second edit')
    assert.equal(history.undone, original)
    await selectLanguage('TypeScript')
    await checkSyntax(false)
    assert.equal(
      await page.evaluate(async () => {
        await window.testModel.redo()
        return window.testModel.getValue()
      }),
      original + '\n// first edit',
    )

    // Cambiar de pestaña y recargar conserva el lenguaje y el contenido.
    await selectLanguage('JavaScript')
    await page.evaluate(() => {
      const tabs = window.testTabs
      tabs.newTab()
      tabs.switchTab('language-test')
    })
    await checkSyntax(true)
    await page.reload()
    await connect()
    await checkSyntax(true)
    assert.equal(await page.locator('#status-language').innerText(), 'JavaScript')
    assert.equal(
      await page.evaluate(() => window.testTabs.state.tabs.find((tab) => tab.id === 'language-test').model.getValue()),
      original + '\n// first edit',
    )
    console.log(`PASS: ${initialLanguage} — syntax, undo, redo, repeated switches, tabs and reload`)
    await context.close()
  }
} finally {
  await browser.close()
}
