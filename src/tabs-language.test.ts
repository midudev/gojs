import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeModel = {
  uri: string
  languageId: string
  getValue(): string
  getLanguageId(): string
  dispose(): void
}

type StoredTab = {
  id: string
  content: string
  language?: 'typescript' | 'javascript'
  isDirty: boolean
  createdAt: number
  updatedAt: number
}

const hasDocument = typeof document !== 'undefined'

function createFakeMonaco() {
  let currentModel: FakeModel | null = null
  const monaco = {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: vi.fn((value: string, languageId: string, uri: string): FakeModel => {
        const model: FakeModel = {
          uri,
          languageId,
          getValue: () => value,
          getLanguageId: () => model.languageId,
          dispose: () => {},
        }
        return model
      }),
      setModelLanguage: vi.fn((model: FakeModel, languageId: string) => {
        model.languageId = languageId
      }),
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyT: 50, KeyW: 53 },
  }
  const editor = {
    setModel: vi.fn((model: FakeModel) => {
      currentModel = model
    }),
    getModel: () => currentModel,
    addAction: vi.fn(),
    onDidChangeModelContent: vi.fn(),
  }
  return { monaco, editor }
}

function seedTabs(tabs: StoredTab[], activeId: string) {
  localStorage.setItem('xjs.tabs', JSON.stringify(tabs))
  localStorage.setItem('xjs.activeTabId', activeId)
}

function storedTabs(): StoredTab[] {
  return JSON.parse(localStorage.getItem('xjs.tabs') ?? '[]')
}

function tab(id: string, language?: StoredTab['language']): StoredTab {
  return { id, content: `// ${id}`, language, isDirty: false, createdAt: 1, updatedAt: 1 }
}

let tabsInstance = 0

async function loadTabs(): Promise<typeof import('./tabs')> {
  // tabs.ts keeps module-level state and vi.resetModules() does not reset it in
  // browser mode, so each test imports its own copy through a unique query.
  tabsInstance += 1
  return import(/* @vite-ignore */ `./tabs.ts?instance=${tabsInstance}`)
}

describe.runIf(hasDocument)('tab language selector', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = `
      <div class="tabs-container"></div>
      <button id="status-language" type="button" aria-expanded="false"
        popovertarget="status-language-menu" disabled>TypeScript</button>
      <div id="status-language-menu" popover="auto" role="menu">
        <button type="button" role="menuitemradio" aria-checked="true" data-language="typescript">TypeScript</button>
        <button type="button" role="menuitemradio" aria-checked="false" data-language="javascript">JavaScript</button>
      </div>
    `
  })

  it('keeps the menu closed until the selector is ready, then opens it next to the trigger', async () => {
    seedTabs([tab('a')], 'a')
    const trigger = document.querySelector<HTMLButtonElement>('#status-language')!
    const menu = document.querySelector<HTMLElement>('#status-language-menu')!

    // Before initTabs the native popovertarget must not open an unpositioned menu.
    trigger.click()
    expect(menu.matches(':popover-open')).toBe(false)

    const tabs = await loadTabs()
    const { monaco, editor } = createFakeMonaco()
    tabs.initTabs(editor, monaco)

    expect(trigger.disabled).toBe(false)
    trigger.click()
    expect(menu.matches(':popover-open')).toBe(true)
    expect(menu.style.bottom).not.toBe('')
    expect(menu.style.right).not.toBe('')
    menu.hidePopover()
  })

  it('creates JavaScript tabs as .js models', async () => {
    seedTabs([tab('a', 'javascript')], 'a')
    const tabs = await loadTabs()
    const { monaco, editor } = createFakeMonaco()
    tabs.initTabs(editor, monaco)

    expect(monaco.editor.createModel).toHaveBeenCalledWith('// a', 'javascript', 'inmemory://models/a.js')
    expect(document.querySelector('#status-language')?.textContent).toBe('JavaScript')
    expect(document.querySelector<HTMLElement>('.tab-item[data-tab-id="a"]')?.dataset.language).toBe('javascript')
  })

  it('switches the active tab in place from the menu and persists the choice', async () => {
    seedTabs([tab('a')], 'a')
    const tabs = await loadTabs()
    const { monaco, editor } = createFakeMonaco()
    tabs.initTabs(editor, monaco)
    const model = editor.getModel()

    document.querySelector<HTMLButtonElement>('#status-language')!.click()
    document.querySelector<HTMLButtonElement>('#status-language-menu [data-language="javascript"]')!.click()

    // Same model: text, cursor and undo history survive the switch.
    expect(monaco.editor.createModel).toHaveBeenCalledTimes(1)
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(model, 'javascript')
    expect(document.querySelector('#status-language')?.textContent).toBe('JavaScript')
    expect(document.querySelector('#status-language-menu [data-language="javascript"]')?.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('#status-language-menu')?.matches(':popover-open')).toBe(false)
    expect(storedTabs()[0].language).toBe('javascript')
  })

  it('opens new tabs in the language of the active tab', async () => {
    seedTabs([tab('a', 'javascript')], 'a')
    const tabs = await loadTabs()
    const { monaco, editor } = createFakeMonaco()
    tabs.initTabs(editor, monaco)

    tabs.newTab()

    expect(storedTabs()[1].language).toBe('javascript')
    expect(monaco.editor.createModel).toHaveBeenLastCalledWith(
      '',
      'javascript',
      expect.stringMatching(/^inmemory:\/\/models\/.+\.js$/),
    )
  })
})
