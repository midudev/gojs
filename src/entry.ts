const isDesktop = '__TAURI_INTERNALS__' in window
const isPlaygroundRoute = window.location.pathname.startsWith('/app')

if (isDesktop || isPlaygroundRoute) {
  document.querySelector('#landing')?.setAttribute('hidden', '')
  document.querySelector('#app')?.removeAttribute('hidden')
  document.documentElement.lang = 'en'
  document.title = 'GoJS.app - JavaScript/TypeScript Playground'
  void import('./main')
} else {
  document.querySelector('#landing')?.removeAttribute('hidden')
  document.querySelector('#app')?.setAttribute('hidden', '')
  void import('./landing')
}
