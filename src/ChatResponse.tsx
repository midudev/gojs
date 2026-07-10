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
  const codeRef = useRef<HTMLElement | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  const isIncomplete = useIsCodeFenceIncomplete()
  const code = useMemo(() => stringifyCode(children), [children])
  const language = useMemo(() => getLanguage(className), [className])
  const lineCount = useMemo(() => Math.max(1, code.split(/\r\n|\r|\n/).length), [code])
  const languageLabel = getLanguageLabel(language)
  // Evitamos temas no usados en el resaltado estático (colorize toma el tema activo).
  void theme
  void fontSize
  void lineHeight

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  // Resaltado estático con `monaco.editor.colorize`: genera HTML tokenizado sin
  // crear una instancia de editor por bloque. Antes cada bloque de código de una
  // respuesta abría un editor Monaco completo (readOnly), lo que disparaba el uso
  // de memoria y CPU en conversaciones largas.
  useEffect(() => {
    const el = codeRef.current
    if (!el) return

    if (!monaco?.editor?.colorize || isIncomplete) {
      el.textContent = code
      return
    }

    let cancelled = false
    monaco.editor
      .colorize(code, language, { tabSize: 2 })
      .then((html: string) => {
        if (!cancelled) el.innerHTML = html
      })
      .catch(() => {
        if (!cancelled) el.textContent = code
      })

    return () => {
      cancelled = true
    }
  }, [monaco, isIncomplete, code, language])

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
      <pre
        className="ai-code-block-code"
        style={{ fontFamily, ['--ai-code-lines' as any]: lineCount }}
        aria-label={`Código ${languageLabel} de solo lectura`}
      >
        <code ref={codeRef}>{code}</code>
      </pre>
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
