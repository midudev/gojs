// ignore native Cmd + S or Ctrl + S
document.addEventListener('keydown', (e) => {
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
  }
})
