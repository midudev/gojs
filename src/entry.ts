const isDesktop = '__TAURI_INTERNALS__' in window
const isPlaygroundRoute = window.location.pathname.startsWith('/app')
const embedMode = new URLSearchParams(window.location.search).get('embed')
const isLightweightEmbed = embedMode === 'landing' || embedMode === 'showcase' || embedMode === 'agent-demo'

async function start(): Promise<void> {
  if (isDesktop || isPlaygroundRoute) {
    if (!isLightweightEmbed) await import('./tailwind.css')
    await import('./style.css')
    document.querySelector('#landing')?.setAttribute('hidden', '')
    document.querySelector('#app')?.removeAttribute('hidden')
    document.documentElement.lang = 'en'
    document.title = 'GoJS.app - JavaScript/TypeScript Playground'
    await import('./main')
    document.documentElement.dataset.stylesReady = ''
    return
  }

  await import('./landing.css')
  document.querySelector('.site-header')?.classList.toggle('is-scrolled', window.scrollY > 24)
  document.querySelector('#landing')?.removeAttribute('hidden')
  document.querySelector('#app')?.setAttribute('hidden', '')
  document.documentElement.dataset.stylesReady = ''
  void import('./landing.ts')
}

void start()
