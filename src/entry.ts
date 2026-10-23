const isDesktop = '__TAURI_INTERNALS__' in window || '__TAURI__' in window
const isPlaygroundRoute = window.location.pathname.startsWith('/app')
const embedMode = new URLSearchParams(window.location.search).get('embed')
const isLightweightEmbed = embedMode === 'landing' || embedMode === 'showcase' || embedMode === 'agent-demo'

// Aplica la orientación y la visibilidad del chat guardadas ANTES de que ./main
// defina <resize-panels>. Si no, el primer frame pinta el layout por defecto
// (horizontal, con chat) y se recoloca cuando main.ts arranca.
function applySavedWorkbenchLayout(): void {
  if (isLightweightEmbed) return
  try {
    const settings = JSON.parse(localStorage.getItem('xjs-settings') || 'null')
    const panels = document.querySelector('resize-panels')
    const isMobile = window.matchMedia('(max-width: 767.98px)').matches
    const orientation = isMobile ? 'vertical' : settings?.layoutOrientation
    // En móvil se arranca en la vista de código: el resto de paneles empieza
    // oculto para que el primer frame ya sea el definitivo.
    if (isMobile) {
      document.querySelector('.output-panel')?.setAttribute('hidden', '')
      document.getElementById('chatbot-panel')?.setAttribute('hidden', '')
    }
    if (panels && (orientation === 'horizontal' || orientation === 'vertical')) {
      panels.setAttribute('orientation', orientation)
      document.getElementById('layout-horizontal-icon')?.toggleAttribute('hidden', orientation !== 'horizontal')
      document.getElementById('layout-vertical-icon')?.toggleAttribute('hidden', orientation !== 'vertical')
    }
    if (settings?.aiEnabled === false) {
      document.getElementById('chatbot-panel')?.setAttribute('hidden', '')
      document.getElementById('robot-icon')?.setAttribute('hidden', '')
      document.getElementById('robot-off-icon')?.removeAttribute('hidden')
    }
  } catch {
    // Sin ajustes válidos: main.ts aplica los valores por defecto.
  }
}

// El landing restaura su propio scroll al recargar (index.html desactiva la
// restauración del navegador): si lo hiciera el navegador, lo haría antes de que
// llegue landing.css, con la página sin estilos y otra altura, y daría un salto.
const LANDING_SCROLL_KEY = 'gojs.landing-scroll'

function restoreLandingScroll(): void {
  window.addEventListener('pagehide', () => {
    sessionStorage.setItem(LANDING_SCROLL_KEY, String(window.scrollY))
  })
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
  const saved = Number(sessionStorage.getItem(LANDING_SCROLL_KEY))
  if (navigation?.type === 'navigate' || window.location.hash || !saved) return
  window.scrollTo({ top: saved, behavior: 'instant' })
}

async function start(): Promise<void> {
  if (isDesktop || isPlaygroundRoute) {
    document.documentElement.classList.toggle('is-desktop', isDesktop)
    applySavedWorkbenchLayout()
    document.querySelector('#landing')?.setAttribute('hidden', '')
    document.querySelector('#app')?.removeAttribute('hidden')
    document.documentElement.lang = 'en'
    document.title = 'GoJS.app - JavaScript/TypeScript Playground'
    await Promise.all([
      isLightweightEmbed ? Promise.resolve() : import('./tailwind.css'),
      import('./style.css'),
    ])
    await import('./main')
    document.documentElement.dataset.stylesReady = ''
    return
  }

  await import('./landing.css')
  document.querySelector('#landing')?.removeAttribute('hidden')
  restoreLandingScroll()
  document.querySelector('.site-header')?.classList.toggle('is-scrolled', window.scrollY > 24)
  document.querySelector('#app')?.setAttribute('hidden', '')
  document.documentElement.dataset.stylesReady = ''
  void import('./landing.ts')
}

void start()
