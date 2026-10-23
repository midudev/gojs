import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Streamdown, useIsCodeFenceIncomplete } from 'streamdown'

export type ChatResponseRoot = Pick<Root, 'unmount'>

export interface ChatResponseProps {
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

const LANGUAGE_LABELS: Record<string, string> = {
  plaintext: 'Text',
  console: 'Console',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  shell: 'Shell',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  markdown: 'Markdown',
}

function getLanguageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language.charAt(0).toUpperCase() + language.slice(1)
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
        <button
          className={`ai-code-block-copy${copied ? ' copied' : ''}`}
          type="button"
          onClick={copyCode}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12 5 5L20 7" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
          )}
        </button>
      </figcaption>
      <pre
        className="ai-code-block-code"
        style={{ fontFamily, ['--ai-code-lines' as any]: lineCount }}
        aria-label={`${languageLabel} code`}
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

export function mountChatResponse(container: HTMLElement, props: ChatResponseProps): ChatResponseRoot {
  const root = createRoot(container)
  root.render(<ChatResponse {...props} />)
  return root
}
