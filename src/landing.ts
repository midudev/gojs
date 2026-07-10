type Platform = 'macos' | 'windows' | 'linux' | 'unknown'

const RELEASE_URL = 'https://github.com/midudev/gojs/releases/latest'

const platformCopy: Record<Platform, { label: string; meta: string }> = {
  macos: { label: 'Download for macOS', meta: 'No account · No license key · Apple Silicon and Intel' },
  windows: { label: 'Download for Windows', meta: 'No account · No license key · Windows 10 and 11' },
  linux: { label: 'Download for Linux', meta: 'No account · No license key · AppImage, deb, and rpm' },
  unknown: {
    label: 'Download for your system',
    meta: 'No account · No license key · macOS, Windows, and Linux',
  },
}

function detectPlatform(): Platform {
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (platform.includes('mac')) return 'macos'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux')) return 'linux'
  return 'unknown'
}

function setDownloadExperience(): void {
  const copy = platformCopy[detectPlatform()]
  const labels = [
    document.querySelector<HTMLSpanElement>('#download-label'),
    document.querySelector<HTMLSpanElement>('#download-label-bottom'),
  ]
  const links = [
    document.querySelector<HTMLAnchorElement>('#download-cta'),
    document.querySelector<HTMLAnchorElement>('#download-cta-bottom'),
  ]

  labels.forEach((label) => {
    if (label) label.textContent = copy.label
  })
  links.forEach((link) => {
    if (link) link.href = RELEASE_URL
  })

  const meta = document.querySelector<HTMLElement>('#download-meta')
  if (meta) meta.textContent = copy.meta
}

function initHeader(): void {
  const header = document.querySelector<HTMLElement>('.site-header')
  if (!header) return

  let scheduled = false
  const update = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 24)
    scheduled = false
  }
  const onScroll = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(update)
  }

  update()
  window.addEventListener('scroll', onScroll, { passive: true })
}

function initReveals(): void {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('.reveal')).filter(
    (section) => !section.closest('.hero'),
  )
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    sections.forEach((section) => section.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
  )

  sections.forEach((section) => observer.observe(section))
}

function initShowcase(): void {
  const frame = document.querySelector<HTMLIFrameElement>('#showcase-frame')
  const loader = document.querySelector<HTMLElement>('#showcase-loader')
  const loadButton = document.querySelector<HTMLButtonElement>('#showcase-load')
  const stage = document.querySelector<HTMLElement>('#playground')
  if (!frame || !loader || !stage) return

  let started = false
  const load = () => {
    if (started) return
    started = true
    const source = frame.dataset.src
    if (source) frame.src = source
    loadButton?.setAttribute('disabled', '')
    if (loadButton) loadButton.textContent = 'Loading playground…'
  }

  frame.addEventListener(
    'load',
    () => {
      loader.classList.add('is-loaded')
      window.setTimeout(() => loader.setAttribute('hidden', ''), 260)
    },
    { once: true },
  )
  loadButton?.addEventListener('click', load)

  if (!('IntersectionObserver' in window)) {
    load()
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      load()
      observer.disconnect()
    },
    { rootMargin: '180px 0px', threshold: 0.05 },
  )
  observer.observe(stage)
}

setDownloadExperience()
initHeader()
initReveals()
initShowcase()
