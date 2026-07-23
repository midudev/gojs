const MAX_PREFIX_CHARS = 7_600
const MAX_SUFFIX_CHARS = 2_600
const RELATED_FILE_BUDGET = 1_400
const MAX_RELATED_FILES = 2
const CACHE_TTL_MS = 3 * 60_000
const NEGATIVE_CACHE_TTL_MS = 1_500
const MAX_CACHE_ENTRIES = 96

export const FIM_STOP_SEQUENCES = [
  '<|endoftext|>',
  '<|fim_prefix|>',
  '<|fim_middle|>',
  '<|fim_suffix|>',
  '<|fim_pad|>',
  '<|repo_name|>',
  '<|file_sep|>',
  '<|im_start|>',
  '<|im_end|>',
] as const

type MonacoPosition = {
  lineNumber: number
  column: number
}

type MonacoModel = {
  getValue(): string
  getOffsetAt(position: MonacoPosition): number
  getVersionId(): number
  getLanguageId(): string
  uri?: { toString(): string }
}

type CancellationToken = {
  isCancellationRequested: boolean
}

type Disposable = {
  dispose(): void
}

type MonacoApi = {
  Range: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) => unknown
  languages: {
    registerInlineCompletionsProvider(languageId: string, provider: unknown): Disposable
  }
}

type EditorApi = {
  getSelection(): { isEmpty(): boolean } | null
}

export interface RelatedCodeFile {
  path: string
  content: string
  updatedAt?: number
}

export interface AutocompleteDiagnostic {
  line: number
  severity: string
  message: string
}

export interface AutocompleteContext {
  code: string
  cursorOffset: number
  language: string
  filePath: string
  line: number
  column: number
  runtime: 'browser' | 'node'
  relatedFiles: RelatedCodeFile[]
  diagnostics: AutocompleteDiagnostic[]
}

export interface InlineGenerationRequest {
  prefix: string
  suffix: string
  maxTokens: number
  temperature: number
  stop: string[]
  seed: number
  candidateCount: number
  signal: AbortSignal
}

export interface InlineGenerationCandidate {
  text: string
  finishReason?: string | null
}

interface AdditionalAutocompleteContext {
  filePath: string
  runtime: 'browser' | 'node'
  relatedFiles: RelatedCodeFile[]
  diagnostics: AutocompleteDiagnostic[]
}

export interface AiAutocompleteOptions {
  monaco: MonacoApi
  editor: EditorApi
  canGenerate: () => boolean
  getAdditionalContext: (model: MonacoModel, position: MonacoPosition) => AdditionalAutocompleteContext
  generate: (request: InlineGenerationRequest) => Promise<InlineGenerationCandidate[]>
  rankCandidates?: (code: string, cursorOffset: number, candidates: string[], language: string) => Promise<string[]>
  getCandidateCount?: () => number
  getCacheNamespace?: () => string
  onStatusChange?: (status: 'idle' | 'thinking' | 'suggested') => void
}

function escapeFimTokens(value: string): string {
  return value.replace(/<\|/g, '<\u200b|')
}

function takeTail(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const start = value.length - maximum
  const nextLine = value.indexOf('\n', start)
  return value.slice(nextLine === -1 ? start : nextLine + 1)
}

function takeHead(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const previousLine = value.lastIndexOf('\n', maximum)
  return value.slice(0, previousLine === -1 ? maximum : previousLine + 1)
}

function identifiers(value: string): Set<string> {
  const result = new Set<string>()
  for (const match of value.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    result.add(match[0])
  }
  return result
}

export function selectRelatedFiles(
  activePath: string,
  activeCode: string,
  cursorOffset: number,
  files: RelatedCodeFile[],
): RelatedCodeFile[] {
  const localIdentifiers = identifiers(activeCode.slice(Math.max(0, cursorOffset - 1_200), cursorOffset + 600))
  const importedPaths = new Set(
    [...activeCode.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map((match) => match[2]),
  )

  return files
    .filter((file) => file.path !== activePath && file.content.trim().length > 0)
    .map((file) => {
      const fileIdentifiers = identifiers(file.content)
      let score = 0
      for (const identifier of localIdentifiers) {
        if (fileIdentifiers.has(identifier)) score += 1
      }
      const baseName = file.path.replace(/\.[^.]+$/, '').split('/').pop() ?? file.path
      if ([...importedPaths].some((path) => path.endsWith(baseName))) score += 25
      if (new RegExp(`\\b${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(activeCode)) score += 8
      return { file, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || (right.file.updatedAt ?? 0) - (left.file.updatedAt ?? 0))
    .slice(0, MAX_RELATED_FILES)
    .map(({ file }) => file)
}

function relatedFileSnippet(file: RelatedCodeFile, activeIdentifiers: Set<string>): string {
  if (file.content.length <= RELATED_FILE_BUDGET) return file.content

  const lines = file.content.split('\n')
  const relevantLines = new Set<number>()
  lines.forEach((line, index) => {
    if ([...activeIdentifiers].some((identifier) => line.includes(identifier))) {
      for (let offset = -2; offset <= 2; offset += 1) relevantLines.add(index + offset)
    }
  })
  const snippet = lines.filter((_, index) => relevantLines.has(index)).join('\n')
  return takeHead(snippet || file.content, RELATED_FILE_BUDGET)
}

export function buildFimInput(context: AutocompleteContext): { prefix: string; suffix: string } {
  const activePrefix = takeTail(context.code.slice(0, context.cursorOffset), MAX_PREFIX_CHARS)
  const activeSuffix = takeHead(context.code.slice(context.cursorOffset), MAX_SUFFIX_CHARS)
  const activeIdentifiers = identifiers(activePrefix.slice(-1_500))
  const metadata = [
    `runtime: ${context.runtime}`,
    `cursor: L${context.line}:C${context.column}`,
    ...context.diagnostics
      .filter((diagnostic) => Math.abs(diagnostic.line - context.line) <= 5)
      .slice(0, 4)
      .map((diagnostic) => `${diagnostic.severity} L${diagnostic.line}: ${diagnostic.message}`),
  ].join('\n')

  const repositoryContext = [
    '<|repo_name|>gojs-playground',
    `<|file_sep|>__editor_context__.txt\n${metadata}`,
    ...context.relatedFiles.map(
      (file) =>
        `<|file_sep|>${escapeFimTokens(file.path)}\n${escapeFimTokens(relatedFileSnippet(file, activeIdentifiers))}`,
    ),
    `<|file_sep|>${escapeFimTokens(context.filePath)}`,
  ].join('\n')

  return {
    prefix: `${repositoryContext}\n${escapeFimTokens(activePrefix)}`,
    suffix: escapeFimTokens(activeSuffix),
  }
}

export function buildAutocompleteMessages(
  code: string,
  cursorOffset: number,
  language: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const prefix = code.slice(Math.max(0, cursorOffset - MAX_PREFIX_CHARS), cursorOffset)
  const suffix = code.slice(cursorOffset, cursorOffset + MAX_SUFFIX_CHARS)

  return [
    {
      role: 'system',
      content:
        'You are an inline code completion engine. Return only the exact code to insert at the cursor. Never use Markdown fences, explanations, or repeat code before the cursor. Keep the completion concise and syntactically valid.',
    },
    {
      role: 'user',
      content: `Language: ${language}

Code before cursor:
<prefix>
${prefix}
</prefix>

Code after cursor:
<suffix>
${suffix}
</suffix>

Complete the code at the cursor.`,
    },
  ]
}

export function sanitizeAutocomplete(rawCompletion: string, prefix: string): string {
  return sanitizeAutocompleteWithSuffix(rawCompletion, prefix, '')
}

export function sanitizeAutocompleteWithSuffix(
  rawCompletion: string,
  prefix: string,
  suffix: string,
): string {
  let completion = rawCompletion.replace(/\r\n?/g, '\n')
  completion = completion
    .replace(/^\s*```(?:javascript|typescript|jsx|tsx|js|ts)?[ \t]*\n?/i, '')
    .replace(/\n?```[ \t]*$/i, '')

  const controlTokenIndex = completion.search(
    /<\|(?:im_start|im_end|endoftext|fim_prefix|fim_middle|fim_suffix|fim_pad|repo_name|file_sep)\|>/,
  )
  if (controlTokenIndex !== -1) completion = completion.slice(0, controlTokenIndex)
  if (/^\s*(?:here(?:'s| is)|sure\b|the completion\b|explanation\b)/i.test(completion)) return ''

  const maxOverlap = Math.min(prefix.length, completion.length)
  for (let length = maxOverlap; length > 0; length -= 1) {
    const overlap = completion.slice(0, length)
    const partialWord = /[\w$]$/.test(prefix) && /^[\w$]+$/.test(overlap)
    if ((length >= 4 || partialWord) && prefix.endsWith(overlap)) {
      completion = completion.slice(length)
      break
    }
  }

  const maxSuffixOverlap = Math.min(suffix.length, completion.length)
  for (let length = maxSuffixOverlap; length > 0; length -= 1) {
    const overlap = completion.slice(-length)
    const safeSingleCharacter = length === 1 && /^[)\]}'"`;,]$/.test(overlap)
    if ((length >= 2 || safeSingleCharacter) && suffix.startsWith(overlap)) {
      completion = completion.slice(0, -length)
      break
    }
  }

  return completion.replace(/[ \t]+$/, '')
}

function hash(value: string): number {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

function completionProfile(prefix: string, triggerKind: number | undefined) {
  if (triggerKind === 1) return { delay: 0, maxTokens: 128 }
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (/\.[A-Za-z_$]*$/.test(currentLine)) return { delay: 140, maxTokens: 32 }
  if (/[{[(]\s*$/.test(currentLine) || currentLine.trim() === '') return { delay: 260, maxTokens: 128 }
  return { delay: 220, maxTokens: 64 }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Inline completion cancelled', 'AbortError'))
      },
      { once: true },
    )
  })
}

type CachedCompletion = {
  text: string
  expiresAt: number
}

class CompletionCache {
  private readonly entries = new Map<string, CachedCompletion>()

  get(key: string): string | null | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.text
  }

  set(key: string, text: string) {
    this.entries.delete(key)
    this.entries.set(key, {
      text,
      expiresAt: Date.now() + (text ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
    })
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

type Continuation = {
  uri: string
  prefix: string
  suffix: string
  text: string
}

function localCandidateScore(candidate: string, context: AutocompleteContext): number {
  const localIdentifiers = identifiers(context.code.slice(Math.max(0, context.cursorOffset - 1_000), context.cursorOffset))
  const candidateIdentifiers = identifiers(candidate)
  let reusedIdentifiers = 0
  for (const identifier of candidateIdentifiers) {
    if (localIdentifiers.has(identifier)) reusedIdentifiers += 1
  }
  const openers = (candidate.match(/[({[]/g) ?? []).length
  const closers = (candidate.match(/[)}\]]/g) ?? []).length
  const delimiterPenalty = Math.abs(openers - closers) * 0.5
  const lengthPenalty = Math.max(0, candidate.length - 500) / 100
  return reusedIdentifiers * 0.4 - delimiterPenalty - lengthPenalty
}

export function registerAiAutocomplete(options: AiAutocompleteOptions): Disposable {
  let requestSequence = 0
  let activeController: AbortController | null = null
  let continuation: Continuation | null = null
  const cache = new CompletionCache()

  const provider = {
    async provideInlineCompletions(
      model: MonacoModel,
      position: MonacoPosition,
      inlineContext: { triggerKind?: number },
      token: CancellationToken,
    ) {
      const requestId = ++requestSequence
      activeController?.abort()
      activeController = null
      options.onStatusChange?.('idle')

      if (!options.canGenerate() || token.isCancellationRequested) {
        return { items: [] }
      }

      const selection = options.editor.getSelection()
      if (selection && !selection.isEmpty()) return { items: [] }

      const code = model.getValue()
      const cursorOffset = model.getOffsetAt(position)
      const prefix = code.slice(0, cursorOffset)
      const suffix = code.slice(cursorOffset)
      if (code.trim().length < 4) return { items: [] }
      const uri = model.uri?.toString() ?? 'active-model'

      if (continuation?.uri === uri && prefix.startsWith(continuation.prefix) && continuation.suffix === suffix) {
        const consumed = prefix.slice(continuation.prefix.length)
        if (consumed && continuation.text.startsWith(consumed)) {
          const insertText = continuation.text.slice(consumed.length)
          if (insertText) {
            options.onStatusChange?.('suggested')
            return {
              items: [
                {
                  insertText,
                  range: new options.monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column,
                  ),
                },
              ],
            }
          }
        }
      }

      const additionalContext = options.getAdditionalContext(model, position)
      const relatedFiles = selectRelatedFiles(
        additionalContext.filePath,
        code,
        cursorOffset,
        additionalContext.relatedFiles,
      )
      const context: AutocompleteContext = {
        code,
        cursorOffset,
        language: model.getLanguageId(),
        line: position.lineNumber,
        column: position.column,
        ...additionalContext,
        relatedFiles,
      }
      const fim = buildFimInput(context)
      const cacheKey = `${options.getCacheNamespace?.() ?? 'local-model'}:${uri}:${hash(`${fim.prefix}\u0000${fim.suffix}`)}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined) {
        if (!cached) {
          options.onStatusChange?.('idle')
          return { items: [] }
        }
        continuation = { uri, prefix, suffix, text: cached }
        options.onStatusChange?.('suggested')
        return {
          items: [
            {
              insertText: cached,
              range: new options.monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        }
      }

      const controller = new AbortController()
      activeController = controller
      options.onStatusChange?.('thinking')
      const profile = completionProfile(prefix, inlineContext.triggerKind)
      const cancellationWatcher = setInterval(() => {
        if (token.isCancellationRequested) controller.abort()
      }, 25)

      const modelVersion = model.getVersionId()
      let didSuggest = false

      try {
        await abortableDelay(profile.delay, controller.signal)
        if (requestId !== requestSequence || !options.canGenerate()) return { items: [] }

        const rawCandidates = await options.generate({
          prefix: fim.prefix,
          suffix: fim.suffix,
          maxTokens: profile.maxTokens,
          temperature: 0,
          stop: [...FIM_STOP_SEQUENCES],
          seed: hash(cacheKey),
          candidateCount: options.getCandidateCount?.() ?? 1,
          signal: controller.signal,
        })

        if (
          token.isCancellationRequested ||
          controller.signal.aborted ||
          requestId !== requestSequence ||
          model.getVersionId() !== modelVersion ||
          !options.canGenerate()
        ) {
          return { items: [] }
        }

        let candidates = rawCandidates
          .map((candidate) => sanitizeAutocompleteWithSuffix(candidate.text, prefix, suffix))
          .filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index)
          .sort((left, right) => localCandidateScore(right, context) - localCandidateScore(left, context))
        if (options.rankCandidates && candidates.length > 0) {
          candidates = await options.rankCandidates(code, cursorOffset, candidates, model.getLanguageId())
        }
        if (
          token.isCancellationRequested ||
          controller.signal.aborted ||
          requestId !== requestSequence ||
          model.getVersionId() !== modelVersion ||
          !options.canGenerate()
        ) {
          return { items: [] }
        }

        const insertText = candidates[0] ?? ''
        cache.set(cacheKey, insertText)
        if (!insertText) return { items: [] }
        continuation = { uri, prefix, suffix, text: insertText }
        didSuggest = true
        options.onStatusChange?.('suggested')

        return {
          items: [
            {
              insertText,
              range: new options.monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('[ai-autocomplete] Completion failed:', error)
        }
        return { items: [] }
      } finally {
        clearInterval(cancellationWatcher)
        if (activeController === controller) {
          activeController = null
          if (!didSuggest) options.onStatusChange?.('idle')
        }
      }
    },
    freeInlineCompletions() {},
  }

  const disposables = ['javascript', 'typescript'].map((languageId) =>
    options.monaco.languages.registerInlineCompletionsProvider(languageId, provider),
  )

  return {
    dispose() {
      requestSequence += 1
      activeController?.abort()
      activeController = null
      options.onStatusChange?.('idle')
      for (const disposable of disposables) disposable.dispose()
    },
  }
}
