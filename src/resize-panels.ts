interface MediaQueryInfo {
  mediaQuery: MediaQueryList
  handler: (e: MediaQueryListEvent) => void
}

interface ResponsiveConfig {
  default?: string
  breakpoints?: Array<{
    query: string
    orientation: string
  }>
}

interface Breakpoint {
  query: string
  orientation: string
}

type PanelOrientation = 'horizontal' | 'vertical'

function isPanelOrientation(value: string | null): value is PanelOrientation {
  return value === 'horizontal' || value === 'vertical'
}

class ResizePanels extends HTMLElement {
  private panels: HTMLElement[] = []
  private dividers: HTMLElement[] = []
  private isDragging: boolean = false
  private currentDivider: HTMLElement | null = null
  private mediaQueries: MediaQueryInfo[] = []
  private currentOrientation: string | null = null
  private responsiveConfig?: ResponsiveConfig
  private currentPanelIndex: number = 0
  private startX: number = 0
  private startY: number = 0
  private startWidths: number[] = []
  private startHeights: number[] = []
  // Estado del arrastre en curso, cacheado al empezar para no consultar
  // getComputedStyle en cada mousemove.
  private dragPairSum: number = 0
  private dragLeftConstraints: { min: number; max: number } = { min: 50, max: Infinity }
  private dragRightConstraints: { min: number; max: number } = { min: 50, max: Infinity }
  private dragRafId: number | null = null
  private dragPointer: number = 0
  private mutationObserver?: MutationObserver
  private layoutUpdateScheduled: boolean = false
  private onDividerMouseDownBound: (e: MouseEvent) => void
  private onMouseMoveBound: (e: MouseEvent) => void
  private onMouseUpBound: (e: MouseEvent) => void
  private handleSlotChangeBound: () => void
  private globalListenersAttached: boolean = false
  private isUpdatingLayout: boolean = false

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.onDividerMouseDownBound = this.onDividerMouseDown.bind(this)
    this.onMouseMoveBound = this.onMouseMove.bind(this)
    this.onMouseUpBound = this.onMouseUp.bind(this)
    this.handleSlotChangeBound = this.scheduleLayoutUpdate.bind(this)
  }

  connectedCallback() {
    this.setupResponsiveConfig()
    this.render()
    this.setupPanels()
    this.setupDividers()
    this.observeSlotChanges()
    this.scheduleLayoutUpdate()
  }

  disconnectedCallback() {
    this.clearMediaQueries()

    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
      this.mutationObserver = undefined
    }

    if (this.globalListenersAttached) {
      document.removeEventListener('mousemove', this.onMouseMoveBound)
      document.removeEventListener('mouseup', this.onMouseUpBound)
      this.globalListenersAttached = false
    }
  }

  clearMediaQueries() {
    this.mediaQueries.forEach((mq: MediaQueryInfo) => {
      mq.mediaQuery.removeEventListener('change', mq.handler)
    })
    this.mediaQueries = []
  }

  getOrientationOverride() {
    const orientation = this.getAttribute('orientation')
    return isPanelOrientation(orientation) ? orientation : null
  }

  setupResponsiveConfig() {
    this.clearMediaQueries()
    this.currentOrientation = null

    const orientationOverride = this.getOrientationOverride()
    if (orientationOverride) {
      this.currentOrientation = orientationOverride
      return
    }

    const configAttr = this.getAttribute('responsive-config')

    if (configAttr) {
      try {
        const config = JSON.parse(configAttr)
        this.responsiveConfig = config

        // Configurar media queries
        if (config.breakpoints) {
          config.breakpoints.forEach((bp: Breakpoint) => {
            const mq = window.matchMedia(bp.query)
            const handler = (e: MediaQueryListEvent) => {
              if (this.getOrientationOverride()) return

              if (e.matches) {
                this.updateOrientation(bp.orientation)
              }
            }

            mq.addEventListener('change', handler)
            this.mediaQueries.push({ mediaQuery: mq, handler })

            // Aplicar inmediatamente si coincide
            if (mq.matches) {
              this.currentOrientation = bp.orientation
            }
          })
        }

        // Si ninguna media query coincide, usar la orientación por defecto
        if (!this.currentOrientation) {
          this.currentOrientation = config.default || 'horizontal'
        }
      } catch (e) {
        console.error('Error parsing responsive-config:', e)
        this.currentOrientation = this.getAttribute('orientation') || 'horizontal'
      }
    } else {
      this.currentOrientation = this.getAttribute('orientation') || 'horizontal'
    }
  }

  updateOrientation(nextOrientation = this.currentOrientation) {
    const oldOrientation = this.orientation
    if (nextOrientation && oldOrientation !== nextOrientation) {
      this.currentOrientation = nextOrientation
      this.render()
      this.setupPanels()
      this.setupDividers()
    }
  }

  get orientation() {
    return this.currentOrientation || this.getAttribute('orientation') || 'horizontal'
  }

  get isHorizontal() {
    return this.orientation === 'horizontal'
  }

  render() {
    // Reflejar siempre la orientación efectiva, también cuando viene del
    // responsive-config y no existe un atributo `orientation` explícito.
    this.dataset.orientation = this.orientation

    const style = document.createElement('style')
    style.textContent = `
          :host {
              --resize-panel-divider-color: var(--surface-divider-color, var(--color-border, #3e3e3e));
              --resize-panel-accent-color: var(--color-accent, #4fc3f7);
              display: flex;
              flex-direction: ${this.isHorizontal ? 'row' : 'column'};
              width: 100%;
              height: 100%;
              overflow: hidden;
              position: relative;
          }

          .panel-wrapper {
              flex: 1;
              overflow: hidden;
              min-width: 0;
              min-height: 0;
              position: relative;
          }

          .divider {
              width: ${this.isHorizontal ? '4px' : '100%'};
              height: ${this.isHorizontal ? '100%' : '4px'};
              background-color: transparent;
              cursor: ${this.isHorizontal ? 'col-resize' : 'row-resize'};
              flex-shrink: 0;
              position: relative;
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 10;
          }

          /* Línea visual del divider */
          .divider::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              width: ${this.isHorizontal ? '1px' : '100%'};
              height: ${this.isHorizontal ? '100%' : '1px'};
              background-color: var(--resize-panel-divider-color);
              transition: all 0.2s ease;
          }

          /* Línea más gruesa en hover/active sin afectar el layout */
          .divider:hover::before {
              width: ${this.isHorizontal ? '2px' : '100%'};
              height: ${this.isHorizontal ? '100%' : '2px'};
              background-color: var(--resize-panel-accent-color);
              box-shadow: 0 0 8px color-mix(in srgb, var(--resize-panel-accent-color) 30%, transparent);
          }

          .divider.dragging::before {
              width: ${this.isHorizontal ? '3px' : '100%'};
              height: ${this.isHorizontal ? '100%' : '3px'};
              background-color: var(--resize-panel-accent-color);
              box-shadow: 0 0 12px color-mix(in srgb, var(--resize-panel-accent-color) 45%, transparent);
          }

          ::slotted(*) {
              width: 100%;
              height: 100%;
              box-sizing: border-box;
          }
      `

    if (!this.shadowRoot) return

    this.shadowRoot.innerHTML = ''
    this.shadowRoot.appendChild(style)
    this.dividers = []

    const children = Array.from(this.children)
    children.forEach((child, index) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'panel-wrapper'

      const slot = document.createElement('slot')
      slot.name = `panel-${index}`
      slot.addEventListener('slotchange', this.handleSlotChangeBound)
      wrapper.appendChild(slot)

      this.shadowRoot!.appendChild(wrapper)
      child.slot = `panel-${index}`

      if (index < children.length - 1) {
        const divider = document.createElement('div')
        divider.className = `divider ${this.orientation}`
        divider.dataset.index = String(index)
        this.shadowRoot!.appendChild(divider)
        this.dividers.push(divider)
      }
    })
  }

  setupPanels() {
    const wrappers = this.shadowRoot?.querySelectorAll('.panel-wrapper')
    this.panels = Array.from(wrappers || []) as HTMLElement[]

    // Inicializar tamaños equitativos
    const initialSize = 100 / this.panels.length
    this.panels.forEach((panel) => {
      panel.style.flex = `0 0 ${initialSize}%`
      panel.dataset.visible = 'true'
      panel.dataset.lastSize = ''
      panel.style.display = 'flex'
    })

    this.scheduleLayoutUpdate()
  }

  setupDividers() {
    this.dividers.forEach((divider) => {
      divider.addEventListener('mousedown', this.onDividerMouseDownBound)
    })

    if (!this.globalListenersAttached) {
      document.addEventListener('mousemove', this.onMouseMoveBound)
      document.addEventListener('mouseup', this.onMouseUpBound)
      this.globalListenersAttached = true
    }

    this.scheduleLayoutUpdate()
  }

  onDividerMouseDown(e: MouseEvent) {
    e.preventDefault()
    this.isDragging = true
    this.currentDivider = e.target as HTMLElement
    this.currentDivider.classList.add('dragging')

    const index = parseInt(this.currentDivider.dataset.index || '0')
    this.currentPanelIndex = index

    const leftPanel = this.panels[index]
    const rightPanel = this.panels[index + 1]
    const leftChild = this.getPanelChild(leftPanel) as HTMLElement
    const rightChild = this.getPanelChild(rightPanel) as HTMLElement

    // Cachear restricciones (getComputedStyle es costoso) una sola vez por arrastre.
    this.dragLeftConstraints = leftChild ? this.getConstraints(leftChild) : { min: 50, max: Infinity }
    this.dragRightConstraints = rightChild ? this.getConstraints(rightChild) : { min: 50, max: Infinity }

    if (this.isHorizontal) {
      this.startX = e.clientX
      this.dragPointer = e.clientX
      this.startWidths = this.getCurrentSizes()
      this.dragPairSum = this.startWidths[index] + this.startWidths[index + 1]
    } else {
      this.startY = e.clientY
      this.dragPointer = e.clientY
      this.startHeights = this.getCurrentSizes()
      this.dragPairSum = this.startHeights[index] + this.startHeights[index + 1]
    }

    document.body.style.cursor = this.isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  getCurrentSizes() {
    return this.panels.map((panel) => {
      const rect = panel.getBoundingClientRect()
      return this.isHorizontal ? rect.width : rect.height
    })
  }

  getConstraints(element: HTMLElement) {
    const computed = window.getComputedStyle(element)

    if (this.isHorizontal) {
      return {
        min: parseFloat(computed.minWidth) || 50,
        max: parseFloat(computed.maxWidth) || Infinity,
      }
    } else {
      return {
        min: parseFloat(computed.minHeight) || 50,
        max: parseFloat(computed.maxHeight) || Infinity,
      }
    }
  }

  getPanelChild(panel: HTMLElement) {
    return panel.querySelector('slot')?.assignedElements()[0] as HTMLElement | undefined
  }

  getPanelConstraints(panel: HTMLElement) {
    const child = this.getPanelChild(panel)

    if (!child) {
      return {
        min: 50,
        max: Infinity,
      }
    }

    return this.getConstraints(child)
  }

  clampSize(size: number, constraints: { min: number; max: number }) {
    return Math.min(Math.max(size, constraints.min), constraints.max)
  }

  distributeConstrainedSizes(
    availableSize: number,
    baseSizes: number[],
    constraints: Array<{ min: number; max: number }>,
  ) {
    const finalSizes = new Array<number>(baseSizes.length)
    const lockedIndexes = new Set<number>()
    let remainingSize = availableSize

    for (let pass = 0; pass < baseSizes.length; pass++) {
      const unlockedIndexes = baseSizes.map((_, index) => index).filter((index) => !lockedIndexes.has(index))

      if (unlockedIndexes.length === 0) break

      const weightSum = unlockedIndexes.reduce((sum, index) => sum + Math.max(0, baseSizes[index]), 0)
      let lockedInThisPass = false

      for (const index of unlockedIndexes) {
        const proposedSize =
          weightSum > 0
            ? (remainingSize * Math.max(0, baseSizes[index])) / weightSum
            : remainingSize / unlockedIndexes.length
        const constrainedSize = this.clampSize(proposedSize, constraints[index])

        if (constrainedSize !== proposedSize) {
          finalSizes[index] = constrainedSize
          lockedIndexes.add(index)
          remainingSize -= constrainedSize
          lockedInThisPass = true
        }
      }

      if (!lockedInThisPass) {
        for (const index of unlockedIndexes) {
          finalSizes[index] =
            weightSum > 0
              ? (remainingSize * Math.max(0, baseSizes[index])) / weightSum
              : remainingSize / unlockedIndexes.length
        }
        break
      }
    }

    return finalSizes
  }

  onMouseMove(e: MouseEvent) {
    if (!this.isDragging) return

    // Solo guardamos la posición del puntero y agrupamos el trabajo real en un
    // único requestAnimationFrame por frame, evitando múltiples reflows por evento.
    this.dragPointer = this.isHorizontal ? e.clientX : e.clientY
    if (this.dragRafId !== null) return
    this.dragRafId = requestAnimationFrame(() => {
      this.dragRafId = null
      this.applyDrag()
    })
  }

  private applyDrag() {
    if (!this.isDragging) return

    const index = this.currentPanelIndex
    const leftPanel = this.panels[index]
    const rightPanel = this.panels[index + 1]
    if (!leftPanel || !rightPanel) return

    const start = this.isHorizontal ? this.startX : this.startY
    const startFirst = this.isHorizontal ? this.startWidths[index] : this.startHeights[index]
    const delta = this.dragPointer - start

    const leftConstraints = this.dragLeftConstraints
    const rightConstraints = this.dragRightConstraints
    const pairSum = this.dragPairSum

    let newFirst = startFirst + delta
    let newSecond = pairSum - newFirst

    // Restricciones del primer panel
    if (newFirst < leftConstraints.min) {
      newFirst = leftConstraints.min
      newSecond = pairSum - newFirst
    } else if (newFirst > leftConstraints.max) {
      newFirst = leftConstraints.max
      newSecond = pairSum - newFirst
    }

    // Restricciones del segundo panel
    if (newSecond < rightConstraints.min) {
      newSecond = rightConstraints.min
      newFirst = pairSum - newSecond
    } else if (newSecond > rightConstraints.max) {
      newSecond = rightConstraints.max
      newFirst = pairSum - newSecond
    }

    leftPanel.style.flex = `0 0 ${newFirst}px`
    rightPanel.style.flex = `0 0 ${newSecond}px`
  }

  onMouseUp() {
    if (!this.isDragging) return

    if (this.dragRafId !== null) {
      cancelAnimationFrame(this.dragRafId)
      this.dragRafId = null
    }

    this.isDragging = false
    if (this.currentDivider) {
      this.currentDivider.classList.remove('dragging')
    }
    this.currentDivider = null

    document.body.style.cursor = ''
    document.body.style.userSelect = ''

    this.scheduleLayoutUpdate()
  }

  static get observedAttributes() {
    return ['orientation', 'responsive-config']
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) {
      if (name === 'responsive-config' || name === 'orientation') {
        this.setupResponsiveConfig()
      }
      this.render()
      this.setupPanels()
      this.setupDividers()
      this.scheduleLayoutUpdate()
    }
  }

  observeSlotChanges() {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect()
    }

    this.mutationObserver = new MutationObserver((mutations) => {
      if (this.isDragging) return

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Cambian los hijos directos: re-sincronizar observadores y layout.
          this.reobserveChildren()
          this.scheduleLayoutUpdate()
          return
        }
        if (mutation.type === 'attributes') {
          this.scheduleLayoutUpdate()
          return
        }
      }
    })

    this.reobserveChildren()
  }

  // Observa SOLO los hijos directos (paneles) y sus atributos de visibilidad, sin
  // `subtree`. Antes se observaba todo el subárbol, incluido el DOM interno de
  // Monaco, que muta continuamente (cursor, tokens, scroll) y disparaba un
  // recálculo de layout con múltiples getBoundingClientRect en cada pulsación.
  private reobserveChildren() {
    if (!this.mutationObserver) return
    this.mutationObserver.disconnect()

    // Alta/baja de paneles (hijos directos del host).
    this.mutationObserver.observe(this, { childList: true })

    // Cambios de visibilidad de cada panel.
    for (const child of Array.from(this.children)) {
      this.mutationObserver.observe(child, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
      })
    }
  }

  scheduleLayoutUpdate() {
    if (this.layoutUpdateScheduled) return
    if (!this.isConnected) return

    this.layoutUpdateScheduled = true
    requestAnimationFrame(() => {
      this.layoutUpdateScheduled = false
      this.updateVisiblePanels()
    })
  }

  updateVisiblePanels() {
    if (this.isDragging) return
    if (!this.shadowRoot) return

    this.isUpdatingLayout = true

    const panelInfos = this.panels.map((panel, index) => {
      const slotEl = panel.querySelector('slot')
      const assigned = slotEl?.assignedElements()[0] as HTMLElement | undefined
      const wasVisible = panel.dataset.visible === 'true'
      const currentlyVisible = assigned ? this.isElementVisible(assigned) : false

      if (wasVisible && !currentlyVisible) {
        const rect = panel.getBoundingClientRect()
        const size = this.isHorizontal ? rect.width : rect.height
        if (size > 0) {
          panel.dataset.lastSize = String(size)
        }
      }

      if (currentlyVisible && (!panel.dataset.lastSize || panel.dataset.lastSize === '0')) {
        const rect = panel.getBoundingClientRect()
        const size = this.isHorizontal ? rect.width : rect.height
        if (size > 0) {
          panel.dataset.lastSize = String(size)
        }
      }

      panel.dataset.visible = currentlyVisible ? 'true' : 'false'
      panel.style.display = currentlyVisible ? 'flex' : 'none'

      const rect = panel.getBoundingClientRect()
      const size = this.isHorizontal ? rect.width : rect.height

      return {
        panel,
        index,
        visible: currentlyVisible,
        size,
      }
    })

    this.dividers.forEach((divider, index) => {
      const leftVisible = panelInfos[index]?.visible
      const rightVisible = panelInfos[index + 1]?.visible
      divider.style.display = leftVisible && rightVisible ? 'flex' : 'none'
    })

    const visibleInfos = panelInfos.filter((info) => info.visible)

    if (visibleInfos.length === 0) {
      // No hay paneles visibles, restablecer estilos y mostrar dividers ocultos
      this.panels.forEach((panel) => {
        panel.style.flex = '0 0 0'
        panel.dataset.lastSize = '0'
      })
      this.dividers.forEach((divider) => {
        divider.style.display = 'none'
      })
      this.isUpdatingLayout = false
      return
    }

    const containerRect = this.getBoundingClientRect()
    const availableSize = Math.max(0, this.isHorizontal ? containerRect.width : containerRect.height)

    const sizes = visibleInfos.map((info) => {
      if (info.size > 0) return info.size
      const stored = parseFloat(info.panel.dataset.lastSize || '0')
      if (stored > 0) return stored
      return 0
    })

    let totalSize = sizes.reduce((sum, size) => sum + size, 0)

    if (availableSize === 0) {
      this.isUpdatingLayout = false
      return
    }

    if (totalSize <= 0) {
      totalSize = availableSize
      sizes.fill(availableSize / visibleInfos.length)
    }

    const constraints = visibleInfos.map((info) => this.getPanelConstraints(info.panel))
    const constrainedSizes = this.distributeConstrainedSizes(availableSize, sizes, constraints)

    visibleInfos.forEach((info, idx) => {
      const currentSize = Math.max(0, sizes[idx]) || totalSize / visibleInfos.length
      const proportion = currentSize / totalSize
      const newSize = Math.max(0, constrainedSizes[idx] ?? availableSize * proportion)
      const flexValue = `0 0 ${newSize}px`
      info.panel.style.flex = flexValue
      info.panel.dataset.lastSize = String(newSize)
    })

    this.isUpdatingLayout = false
  }

  isElementVisible(element: HTMLElement) {
    if (!element) return false
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false
    }
    if (element.hasAttribute('hidden')) {
      return false
    }
    return true
  }

  public requestLayoutUpdate() {
    this.scheduleLayoutUpdate()
  }

  public getOrientation() {
    return this.orientation
  }
}

customElements.define('resize-panels', ResizePanels)
