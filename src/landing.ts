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

initHeader()
initReveals()
initShowcase()
