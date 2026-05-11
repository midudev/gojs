import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Streamdown, useIsCodeFenceIncomplete } from 'streamdown'

interface ChatResponseProps {
  content: string
  isStreaming: boolean
  monaco: any
  theme: string
  fontFamily: string
  fontSize: number
  lineHeight: number
}

interface CodeBlockProps {
  children?: ReactNode
  className?: string
}

interface MonacoCodeBlockProps extends CodeBlockProps {
  monaco: any
  theme: string
  fontFamily: string
  fontSize: number
  lineHeight: number
}

function stringifyCode(children: ReactNode): string {
  if (Array.isArray(children)) {
    return children.map(stringifyCode).join('')
  }

  if (children === null || children === undefined || typeof children === 'boolean') {
    return ''
  }

  return String(children).replace(/\n$/, '')
}

function getLanguage(className?: string): string {
  const language = className?.match(/language-([a-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? 'plaintext'

  const aliases: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    node: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    shell: 'shell',
    bash: 'shell',
    sh: 'shell',
    zsh: 'shell',
    html: 'html',
    css: 'css',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
  }

  return aliases[language] ?? language
}

function getLanguageLabel(language: string): string {
  if (language === 'plaintext') return 'text'
  if (language === 'javascript') return 'javascript'
  if (language === 'typescript') return 'typescript'
  return language
}

function MonacoCodeBlock({ children, className, monaco, theme, fontFamily, fontSize, lineHeight }: MonacoCodeBlockProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<any>(null)
  const copyTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  const isIncomplete = useIsCodeFenceIncomplete()
  const code = useMemo(() => stringifyCode(children), [children])
  const language = useMemo(() => getLanguage(className), [className])
  const lineCount = useMemo(() => Math.max(1, code.split(/\r\n|\r|\n/).length), [code])
  const editorHeight = Math.min(420, Math.max(76, lineCount * lineHeight + 24))
  const languageLabel = getLanguageLabel(language)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!monaco || !containerRef.current || isIncomplete) return

    const editor = monaco.editor.create(containerRef.current, {
      value: code,
      language,
      theme,
      fontFamily,
      fontSize,
      lineHeight,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: lineCount > 1 ? 'on' : 'off',
      glyphMargin: false,
      folding: false,
      links: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: 'none',
      scrollBeyondLastLine: false,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        alwaysConsumeMouseWheel: false,
      },
      padding: {
        top: 12,
        bottom: 12,
      },
    })

    editorRef.current = editor
    editor.layout()

    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [monaco, isIncomplete, language, theme, fontFamily, fontSize, lineHeight, lineCount])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const model = editor.getModel()
    if (model && model.getValue() !== code) {
      model.setValue(code)
    }

    editor.updateOptions({
      lineNumbers: lineCount > 1 ? 'on' : 'off',
    })
    editor.layout({
      width: containerRef.current?.clientWidth ?? 0,
      height: editorHeight,
    })
  }, [code, editorHeight, lineCount])

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)

      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }

      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false)
        copyTimerRef.current = null
      }, 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <figure className="ai-code-block" data-language={languageLabel}>
      <figcaption className="ai-code-block-header">
        <span className="ai-code-block-language">{languageLabel}</span>
        <span className="ai-code-block-readonly">solo lectura</span>
        <button className="ai-code-block-copy" type="button" onClick={copyCode} aria-label="Copiar código">
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </figcaption>
      {monaco && !isIncomplete ? (
        <div
          ref={containerRef}
          className="ai-code-block-editor"
          style={{ height: editorHeight }}
          aria-label={`Código ${languageLabel} de solo lectura`}
        />
      ) : (
        <pre className="ai-code-block-fallback" aria-label={`Código ${languageLabel} de solo lectura`}>
          <code>{code}</code>
        </pre>
      )}
    </figure>
  )
}

function InlineCode({ children }: CodeBlockProps) {
  return <code className="ai-inline-code">{children}</code>
}

export const ChatResponse: React.FC<ChatResponseProps> = ({
  content,
  isStreaming,
  monaco,
  theme,
  fontFamily,
  fontSize,
  lineHeight,
}) => {
  const components = useMemo(
    () => ({
      code: (props: CodeBlockProps) => (
        <MonacoCodeBlock
          {...props}
          monaco={monaco}
          theme={theme}
          fontFamily={fontFamily}
          fontSize={fontSize}
          lineHeight={lineHeight}
        />
      ),
      inlineCode: InlineCode,
    }),
    [monaco, theme, fontFamily, fontSize, lineHeight],
  )

  return (
    <div className="chatbot-message-content">
      <Streamdown isAnimating={isStreaming} components={components}>
        {content}
      </Streamdown>
    </div>
  )
}
