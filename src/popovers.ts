export function initHeaderPopovers() {
  const autorunToggleButton = document.getElementById('autorun-toggle-button') as HTMLElement | null
  const aiToggleButton = document.getElementById('ai-toggle-button') as HTMLElement | null
  const settingsButton = document.getElementById('settings-button') as HTMLElement | null
  const issueButton = document.getElementById('issue-button') as HTMLElement | null

  const tooltipAutorun = document.getElementById('tooltip-autorun') as HTMLElement | null
  const tooltipAI = document.getElementById('tooltip-ai') as HTMLElement | null
  const tooltipSettings = document.getElementById('tooltip-settings') as HTMLElement | null
  const tooltipIssue = document.getElementById('tooltip-issue') as HTMLElement | null

  const attachHintTooltip = (button: HTMLElement | null, tooltip: HTMLElement | null) => {
    if (!button || !tooltip) return

    const show = () => (tooltip as any).showPopover({ source: button })
    const hide = () => tooltip.hidePopover()

    button.addEventListener('mouseover', show)
    button.addEventListener('mouseout', hide)
    button.addEventListener('focus', show)
    button.addEventListener('blur', hide)

    window.addEventListener(
      'scroll',
      () => {
        if (tooltip.matches(':popover-open')) (tooltip as any).showPopover({ source: button })
      },
      { passive: true },
    )
    window.addEventListener('resize', () => {
      if (tooltip.matches(':popover-open')) (tooltip as any).showPopover({ source: button })
    })
  }

  attachHintTooltip(autorunToggleButton, tooltipAutorun)
  attachHintTooltip(aiToggleButton, tooltipAI)
  attachHintTooltip(settingsButton, tooltipSettings)
  attachHintTooltip(issueButton, tooltipIssue)
}
