import './landing.css'

type Platform = 'macos' | 'windows' | 'linux' | 'unknown'

interface GitHubAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  assets?: GitHubAsset[]
}

const RELEASE_URL = 'https://github.com/midudev/gojs/releases/latest'
const RELEASE_API = 'https://api.github.com/repos/midudev/gojs/releases/latest'

const platformCopy: Record<Platform, { label: string; meta: string }> = {
  macos: { label: 'Download for macOS', meta: 'Free and open source · Apple Silicon and Intel' },
  windows: { label: 'Download for Windows', meta: 'Free and open source · Windows 10 and 11' },
  linux: { label: 'Download for Linux', meta: 'Free and open source · AppImage, deb, and rpm' },
  unknown: { label: 'Download for your system', meta: 'Free and open source · macOS, Windows, and Linux' },
}

function detectPlatform(): Platform {
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()

  if (platform.includes('mac')) return 'macos'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux')) return 'linux'
  return 'unknown'
}

function preferredAsset(assets: GitHubAsset[], platform: Platform): GitHubAsset | undefined {
  const candidates = assets.filter((asset) => {
    const name = asset.name.toLowerCase()
    if (platform === 'macos') return name.includes('apple-darwin') && name.endsWith('.dmg')
    if (platform === 'windows') return name.includes('windows-msvc') && name.endsWith('.msi')
    if (platform === 'linux') return name.includes('linux-gnu') && name.endsWith('.appimage')
    return false
  })

  if (platform !== 'macos' || candidates.length < 2) return candidates[0]

  const reportsArm = /arm|aarch64/i.test(navigator.userAgent)
  return candidates.find((asset) => asset.name.includes(reportsArm ? 'aarch64' : 'x86_64')) ?? candidates[0]
}

async function resolveDownloadUrl(platform: Platform): Promise<string> {
  if (platform === 'unknown') return RELEASE_URL

  try {
    const response = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return RELEASE_URL

    const release = (await response.json()) as GitHubRelease
    return preferredAsset(release.assets ?? [], platform)?.browser_download_url ?? RELEASE_URL
  } catch {
    return RELEASE_URL
  }
}

function setDownloadExperience(): void {
  const platform = detectPlatform()
  const copy = platformCopy[platform]
  const labels = [
    document.querySelector<HTMLSpanElement>('#download-label'),
    document.querySelector<HTMLSpanElement>('#download-label-bottom'),
  ]
  const links = [
    document.querySelector<HTMLAnchorElement>('#download-cta'),
    document.querySelector<HTMLAnchorElement>('#download-cta-bottom'),
  ]
  const meta = document.querySelector<HTMLElement>('#download-meta')

  labels.forEach((label) => {
    if (label) label.textContent = copy.label
  })
  if (meta) meta.textContent = copy.meta

  void resolveDownloadUrl(platform).then((url) => {
    links.forEach((link) => {
      if (link) link.href = url
    })
  })
}

function initHeader(): void {
  const header = document.querySelector<HTMLElement>('.site-header')
  if (!header) return

  const updateHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 24)
  updateHeader()
  window.addEventListener('scroll', updateHeader, { passive: true })
}

function initReveals(): void {
  const sections = document.querySelectorAll<HTMLElement>(
    '.section-heading, .bento-card, .desktop-copy, .platform-list > div, .final-cta',
  )

  if (!('IntersectionObserver' in window)) {
    sections.forEach((section) => section.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      })
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  )

  sections.forEach((section) => observer.observe(section))
}

function initCodeRunner(): void {
  const code = document.querySelector<HTMLTextAreaElement>('#runner-code')
  const output = document.querySelector<HTMLOutputElement>('#runner-output')
  const runButton = document.querySelector<HTMLButtonElement>('#runner-run')
  if (!code || !output || !runButton) return

  const workerSource = `
    self.onmessage = ({ data: source }) => {
      const startedAt = performance.now()
      try {
        const value = Function('"use strict";\\n' + source)()
        let text
        if (typeof value === 'string') text = value
        else if (value === undefined) text = 'undefined'
        else {
          try { text = JSON.stringify(value) }
          catch { text = String(value) }
        }
        self.postMessage({ ok: true, text, duration: performance.now() - startedAt })
      } catch (error) {
        self.postMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    }
  `

  const run = () => {
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
    const worker = new Worker(workerUrl)
    runButton.disabled = true

    const finish = () => {
      window.clearTimeout(timeout)
      worker.terminate()
      URL.revokeObjectURL(workerUrl)
      runButton.disabled = false
    }

    const timeout = window.setTimeout(() => {
      output.value = 'Execution timed out'
      output.classList.add('is-error')
      finish()
    }, 1500)

    worker.addEventListener('message', (event: MessageEvent<{ ok: boolean; text: string; duration?: number }>) => {
      const { ok, text, duration = 0 } = event.data
      output.value = ok ? `${text} · ${Math.max(0.1, duration).toFixed(1)} ms` : text
      output.classList.toggle('is-error', !ok)
      finish()
    })

    worker.postMessage(code.value)
  }

  runButton.addEventListener('click', run)
  code.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  })
}

function initInlineDemo(): void {
  const input = document.querySelector<HTMLInputElement>('#inline-demo-input')
  const quantity = document.querySelector<HTMLOutputElement>('#inline-quantity')
  const output = document.querySelector<HTMLOutputElement>('#inline-demo-output')
  if (!input || !quantity || !output) return

  const update = () => {
    quantity.value = input.value
    output.value = (42.5 * Number(input.value)).toFixed(2)
  }

  input.addEventListener('input', update)
  update()
}

setDownloadExperience()
initHeader()
initReveals()
initCodeRunner()
initInlineDemo()
