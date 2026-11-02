export function initHeaderPopovers() {
  const autorunToggleButton = document.getElementById('autorun-toggle-button') as HTMLElement | null
  const aiToggleButton = document.getElementById('ai-toggle-button') as HTMLElement | null
  const layoutToggleButton = document.getElementById('layout-toggle-button') as HTMLElement | null
  const settingsButton = document.getElementById('settings-button') as HTMLElement | null
  const issueButton = document.getElementById('issue-button') as HTMLElement | null
  const historyButton = document.getElementById('history-button') as HTMLElement | null
  const languageButton = document.getElementById('status-language') as HTMLElement | null

  const tooltipAutorun = document.getElementById('tooltip-autorun') as HTMLElement | null
  const tooltipAI = document.getElementById('tooltip-ai') as HTMLElement | null
  const tooltipLayout = document.getElementById('tooltip-layout') as HTMLElement | null
  const tooltipSettings = document.getElementById('tooltip-settings') as HTMLElement | null
  const tooltipIssue = document.getElementById('tooltip-issue') as HTMLElement | null
  const tooltipHistory = document.getElementById('tooltip-history') as HTMLElement | null
  const tooltipLanguage = document.getElementById('tooltip-language') as HTMLElement | null

  const attachHintTooltip = (button: HTMLElement | null, tooltip: HTMLElement | null) => {
    if (!button || !tooltip) return

    // Posiciona el tooltip debajo (y centrado respecto a) el botón usando coordenadas
    // de viewport. No dependemos de CSS Anchor Positioning porque Firefox/Zen no lo
    // soportan y el popover acababa mal posicionado (ver issue #3).
    const position = () => {
      const btnRect = button.getBoundingClientRect()
      const tipRect = tooltip.getBoundingClientRect()
      const margin = 8
      const halfWidth = tipRect.width / 2

      // En la activity bar el tooltip va hacia dentro de la ventana: a la
      // izquierda si la barra es vertical (escritorio) o encima si es la barra
      // inferior de móvil.
      const activityBar = button.closest('.activity-bar')
      if (activityBar) {
        const isVertical = getComputedStyle(activityBar).flexDirection === 'column'
        if (isVertical) {
          tooltip.style.left = `${btnRect.left - 6 - halfWidth}px`
          tooltip.style.top = `${btnRect.top + (btnRect.height - tipRect.height) / 2}px`
          return
        }
        const centerX = Math.max(margin + halfWidth, Math.min(btnRect.left + btnRect.width / 2, window.innerWidth - margin - halfWidth))
        tooltip.style.left = `${centerX}px`
        tooltip.style.top = `${btnRect.top - 6 - tipRect.height}px`
        return
      }

      let centerX = btnRect.left + btnRect.width / 2
      // Evitar que el tooltip se salga por los bordes de la ventana
      centerX = Math.max(margin + halfWidth, Math.min(centerX, window.innerWidth - margin - halfWidth))

      tooltip.style.left = `${centerX}px`
      // En la barra inferior, mostrar el tooltip encima para que quede visible.
      tooltip.style.top = button.closest('.status-bar')
        ? `${btnRect.top - 6 - tipRect.height}px`
        : `${btnRect.bottom + 6}px`
    }

    const show = () => {
      // No tapar las opciones de un menú abierto con el tooltip de su botón.
      if (button.getAttribute('aria-haspopup') === 'menu' && button.getAttribute('aria-expanded') === 'true') return
      try {
        // showPopover() sin argumentos: la variante con { source } es muy reciente y
        // no está disponible en todos los navegadores.
        if (!tooltip.matches(':popover-open')) tooltip.showPopover()
      } catch {
        /* el popover ya estaba abierto */
      }
      position()
    }
    const hide = () => {
      try {
        tooltip.hidePopover()
      } catch {
        /* el popover ya estaba cerrado */
      }
    }

    button.addEventListener('mouseover', show)
    button.addEventListener('mouseout', hide)
    button.addEventListener('focus', show)
    button.addEventListener('blur', hide)
    button.addEventListener('click', hide)

    const reposition = () => {
      if (tooltip.matches(':popover-open')) position()
    }
    window.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('resize', reposition)
  }

  attachHintTooltip(autorunToggleButton, tooltipAutorun)
  attachHintTooltip(aiToggleButton, tooltipAI)
  attachHintTooltip(layoutToggleButton, tooltipLayout)
  attachHintTooltip(settingsButton, tooltipSettings)
  attachHintTooltip(issueButton, tooltipIssue)
  attachHintTooltip(historyButton, tooltipHistory)
  attachHintTooltip(languageButton, tooltipLanguage)
}
