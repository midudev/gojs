import { closeTab, newTab, state } from './tabs'

// ignore native Cmd + S or Ctrl + S
document.addEventListener('keydown', (e) => {
  // ignore native save file
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
  }

  // open new tab
  if (e.key === 't' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    newTab()
  }

  // close tab
  if (e.key === 'w' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    if (state.activeId) {
      closeTab(state.activeId)
    }
  }
})
