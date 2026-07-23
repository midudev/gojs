import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAutocompleteMessages,
  buildFimInput,
  FIM_STOP_SEQUENCES,
  registerAiAutocomplete,
  sanitizeAutocomplete,
  sanitizeAutocompleteWithSuffix,
  selectRelatedFiles,
} from './ai-autocomplete'
import { rankCandidateIndices } from './autocomplete-validation'

afterEach(() => {
  vi.useRealTimers()
})

describe('AI autocomplete', () => {
  it('builds a fill-in-the-middle prompt around the cursor', () => {
    const code = 'const total = prices.\nconsole.log(total)'
    const cursorOffset = code.indexOf('\n')
    const messages = buildAutocompleteMessages(code, cursorOffset, 'typescript')

    expect(messages[0].content).toContain('Return only the exact code to insert')
    expect(messages[1].content).toContain('const total = prices.')
    expect(messages[1].content).toContain('console.log(total)')
    expect(messages[1].content).toContain('Language: typescript')
  })

  it('removes Markdown fences from model output', () => {
    expect(sanitizeAutocomplete('```typescript\nmap((price) => price * 2)\n```', 'const total = prices.')).toBe(
      'map((price) => price * 2)',
    )
  })

  it('does not repeat code already present before the cursor', () => {
    expect(sanitizeAutocomplete('const answer = 42', 'function run() {\n  const ')).toBe('answer = 42')
  })

  it('preserves leading indentation in an insertion', () => {
    expect(sanitizeAutocomplete('\n  return value', 'function read() {')).toBe('\n  return value')
  })

  it('builds repository-aware FIM context with diagnostics and related files', () => {
    const code = "import { total } from './prices'\nconst result = total"
    const input = buildFimInput({
      code,
      cursorOffset: code.length,
      language: 'typescript',
      filePath: 'main.ts',
      line: 2,
      column: 21,
      runtime: 'node',
      relatedFiles: [{ path: 'prices.ts', content: 'export const total = prices.reduce(sum, 0)' }],
      diagnostics: [{ line: 2, severity: 'error', message: 'Cannot find name prices' }],
    })

    expect(input.prefix).toContain('<|repo_name|>gojs-playground')
    expect(input.prefix).toContain('<|file_sep|>prices.ts')
    expect(input.prefix).toContain('runtime: node')
    expect(input.prefix).toContain('error L2: Cannot find name prices')
    expect(input.prefix).toContain('<|file_sep|>main.ts')
    expect(FIM_STOP_SEQUENCES).toContain('<|fim_middle|>')
  })

  it('escapes FIM control markers found inside user code', () => {
    const input = buildFimInput({
      code: 'const marker = "<|fim_suffix|>"',
      cursorOffset: 32,
      language: 'typescript',
      filePath: 'main.ts',
      line: 1,
      column: 33,
      runtime: 'browser',
      relatedFiles: [],
      diagnostics: [],
    })

    expect(input.prefix).not.toContain('"<|fim_suffix|>"')
    expect(input.prefix).toContain('<\u200b|fim_suffix|>')
  })

  it('selects imported and symbol-related tabs instead of unrelated files', () => {
    const files = selectRelatedFiles(
      'main.ts',
      "import { formatPrice } from './money'\nformatPrice(total)",
      56,
      [
        { path: 'money.ts', content: 'export const formatPrice = (total: number) => `${total}`' },
        { path: 'random.ts', content: 'export const unrelated = true' },
      ],
    )

    expect(files.map((file) => file.path)).toEqual(['money.ts'])
  })

  it('removes code repeated from the suffix and duplicate closing characters', () => {
    expect(sanitizeAutocompleteWithSuffix('value)', 'return ', ')\n}')).toBe('value')
    expect(sanitizeAutocompleteWithSuffix('const value = 1\nnext()', '', 'next()')).toBe('const value = 1\n')
  })

  it('rejects prose and truncates leaked control tokens', () => {
    expect(sanitizeAutocompleteWithSuffix('Here is the completion: value', '', '')).toBe('')
    expect(sanitizeAutocompleteWithSuffix('value<|file_sep|>other.ts', '', '')).toBe('value')
  })

  it('rejects a candidate that breaks otherwise valid TypeScript', () => {
    const code = 'const total: number = 1\n'
    expect(rankCandidateIndices(code, code.length, ['const next = 2', 'const next = ('], 'typescript')).toEqual([0])
  })

  it('prefers a candidate that repairs an incomplete expression', () => {
    const code = 'const total = prices.reduce((sum, price) => , 0)'
    const cursorOffset = code.indexOf(', 0)')
    const ranked = rankCandidateIndices(code, cursorOffset, ['sum + price', '('], 'typescript')
    expect(ranked[0]).toBe(0)
  })

  it('cancels a stale debounce and only generates for the latest request', async () => {
    vi.useFakeTimers()
    let provider: any
    const statuses: string[] = []
    const generate = vi.fn(async () => [{ text: 'ue', finishReason: 'stop' }])
    const model = {
      getValue: () => 'const result = val',
      getOffsetAt: () => 18,
      getVersionId: () => 1,
      getLanguageId: () => 'typescript',
      uri: { toString: () => 'inmemory://main.ts' },
    }
    const disposable = registerAiAutocomplete({
      monaco: {
        Range: class Range {
          constructor(
            public startLineNumber: number,
            public startColumn: number,
            public endLineNumber: number,
            public endColumn: number,
          ) {}
        },
        languages: {
          registerInlineCompletionsProvider: (_language, registeredProvider) => {
            provider = registeredProvider
            return { dispose() {} }
          },
        },
      },
      editor: { getSelection: () => ({ isEmpty: () => true }) },
      canGenerate: () => true,
      getAdditionalContext: () => ({
        filePath: 'main.ts',
        runtime: 'browser',
        relatedFiles: [],
        diagnostics: [],
      }),
      generate,
      onStatusChange: (status) => statuses.push(status),
    })

    const first = provider.provideInlineCompletions(model, { lineNumber: 1, column: 19 }, { triggerKind: 0 }, {
      isCancellationRequested: false,
    })
    const second = provider.provideInlineCompletions(model, { lineNumber: 1, column: 19 }, { triggerKind: 0 }, {
      isCancellationRequested: false,
    })
    await vi.advanceTimersByTimeAsync(250)

    expect((await first).items).toEqual([])
    expect((await second).items[0].insertText).toBe('ue')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(statuses).toContain('thinking')
    expect(statuses.at(-1)).toBe('suggested')
    disposable.dispose()
  })
})
