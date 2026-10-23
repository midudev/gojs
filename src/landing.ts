import { createDitherField, createPixelImage, runWhileVisible } from './landing-dither'

const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches
const DITHER_PALETTE = ['transparent', '#1d2b4f', '#3178c6', '#f7df1e']

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function boxOf(element: Element, origin: DOMRect, padding = 0): Box {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left - origin.left - padding,
    top: rect.top - origin.top - padding,
    right: rect.right - origin.left + padding,
    bottom: rect.bottom - origin.top + padding,
  }
}

function distanceToBox(x: number, y: number, box: Box): number {
  const dx = Math.max(box.left - x, 0, x - box.right)
  const dy = Math.max(box.top - y, 0, y - box.bottom)
  return Math.hypot(dx, dy)
}

// Runs `callback` once, when the top of `target` rises above `line` (a fraction
// of the viewport height measured from the top).
function onceInView(target: Element, callback: () => void, line = 0.8): void {
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      callback()
    },
    { rootMargin: `0px 0px -${Math.round((1 - line) * 100)}% 0px` },
  )
  observer.observe(target)
}

// Eases from 0 to 1 over `duration` seconds after `delay`. Returns a cancel function.
function tween(duration: number, delay: number, update: (progress: number) => void, done?: () => void): () => void {
  const start = performance.now() + delay * 1000
  let handle = 0
  const tick = (now: number) => {
    const t = Math.min(Math.max((now - start) / (duration * 1000), 0), 1)
    update(t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
    if (t < 1) handle = requestAnimationFrame(tick)
    else done?.()
  }
  handle = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(handle)
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

// A dithered JS/TS aura around the live playground. It never reaches the copy,
// so the headline and the description keep their contrast.
function initHeroField(): void {
  const container = document.querySelector<HTMLElement>('.hero-field')
  const canvas = container?.querySelector('canvas')
  const frame = document.querySelector<HTMLElement>('.app-window')
  const keepOut = Array.from(document.querySelectorAll<HTMLElement>('.hero-copy'))
  if (!container || !canvas || !frame) return

  let windowBox: Box = { left: 0, top: 0, right: 0, bottom: 0 }
  let clearBoxes: Box[] = []
  const pointer = { x: -1e4, y: -1e4 }

  const measure = () => {
    const origin = container.getBoundingClientRect()
    windowBox = boxOf(frame, origin)
    clearBoxes = keepOut.map((element) => boxOf(element, origin, 12))
  }

  const field = createDitherField({
    canvas,
    palette: DITHER_PALETTE,
    pixelSize: 4,
    onResize: measure,
    sample: (x, y, time) => {
      const dx = Math.max(windowBox.left - x, 0, x - windowBox.right)
      const dy = Math.max(windowBox.top - y, 0, y - windowBox.bottom)
      if ((dx === 0 && dy === 0) || dx >= 173 || dy >= 173) return 0
      const distance = Math.hypot(dx, dy)
      if (distance >= 172.8) return 0

      const pointerDx = x - pointer.x
      const pointerDy = y - pointer.y
      const pointerDistSq = pointerDx * pointerDx + pointerDy * pointerDy
      // When pointer is far away (near ≈ 0), max possible reach is 72 * 1.6 = 115.2.
      if (pointerDistSq > 140000 && distance >= 115.3) return 0

      const near = pointerDistSq > 180000 ? 0 : Math.exp(-pointerDistSq / 20000)
      const drift = Math.sin(x * 0.006 + time * 0.5) * Math.cos(y * 0.008 - time * 0.4)
      const ripple = Math.sin(x * 0.021 - time * 1.1) * Math.sin(y * 0.019 + time * 0.9)
      const reach = 72 * (1 + 0.4 * drift + 0.2 * ripple + 0.8 * near)
      const falloff = 1 - distance / reach
      if (falloff <= 0) return 0
      let clearance = 1
      for (const box of clearBoxes) clearance = Math.min(clearance, distanceToBox(x, y, box) / 48)
      // Mostly a faint blue haze; the pointer heats it up to yellow.
      return falloff * falloff * (0.42 + 0.12 * drift + 0.5 * near) * clearance
    },
  })

  const resizeObserver = new ResizeObserver(() => {
    field.resize()
    field.render(0)
  })
  resizeObserver.observe(container)
  resizeObserver.observe(frame)
  for (const element of keepOut) resizeObserver.observe(element)
  void document.fonts?.ready?.then(() => {
    measure()
    field.render(0)
  })

  if (!motion) {
    field.render(0)
    return
  }

  const hero = container.closest('.hero')
  hero?.addEventListener(
    'pointermove',
    (event) => {
      const origin = container.getBoundingClientRect()
      pointer.x = (event as PointerEvent).clientX - origin.left
      pointer.y = (event as PointerEvent).clientY - origin.top
    },
    { passive: true },
  )
  hero?.addEventListener('pointerleave', () => {
    pointer.x = pointer.y = -1e4
  })

  runWhileVisible(container, (time) => {
    field.render(time)
  })
}

// Logos start as coarse dithered blocks and resolve into the real artwork once.
const PIXEL_STEPS = [28, 20, 14, 10, 7, 5, 4, 3, 2, 1]

function initPixelLogos(): void {
  if (!motion) return

  document.querySelectorAll<HTMLElement>('.pixel-logo').forEach((logo, index) => {
    const image = logo.querySelector('img')
    const canvas = logo.querySelector('canvas')
    if (!image || !canvas) return

    const draw = createPixelImage(canvas, image)
    let drawn = 0
    let cancel: (() => void) | null = null

    const resolve = (fromStep: number, duration: number, delay = 0) => {
      cancel?.()
      logo.classList.add('is-pixelated')
      drawn = 0
      const remaining = PIXEL_STEPS.length - 1 - fromStep
      cancel = tween(
        duration,
        delay,
        (progress) => {
          const block = PIXEL_STEPS[fromStep + Math.round(progress * remaining)]
          if (block === drawn) return
          drawn = block
          draw(block)
        },
        () => logo.classList.remove('is-pixelated'),
      )
    }

    image
      .decode()
      .catch(() => undefined)
      .then(() => {
        logo.classList.add('is-pixelated')
        draw(PIXEL_STEPS[0])
        onceInView(logo, () => resolve(0, 1.2, index * 0.18), 0.82)
        logo.addEventListener('pointerenter', () => {
          if (!logo.classList.contains('is-pixelated')) resolve(4, 0.55)
        })
      })
  })
}

// The specimens play their story once: values arrive line by line, and the
// runtime switches from the browser to Node.js. The animations live in CSS;
// this only decides when they start.
function initSpecimens(): void {
  if (!motion) return

  const specimen = document.querySelector('.code-specimen')
  if (specimen) {
    specimen.classList.add('is-waiting')
    onceInView(specimen, () => specimen.classList.replace('is-waiting', 'is-playing'), 0.72)
  }

  const terminal = document.querySelector<HTMLElement>('.runtime-terminal')
  if (terminal) {
    terminal.dataset.runtime = 'browser'
    terminal.classList.add('is-waiting')
    onceInView(
      terminal,
      () => {
        terminal.classList.replace('is-waiting', 'is-playing')
        window.setTimeout(() => {
          terminal.dataset.runtime = 'node'
        }, 1500)
      },
      0.68,
    )
  }
}

// A dithered sun that rises while the last section scrolls into view. It
// follows the pointer, beams light at it, flares while the call to action is
// hovered, and sends out pixel ripples on click.
function initSunrise(): void {
  const section = document.querySelector<HTMLElement>('.final-cta')
  const container = section?.querySelector<HTMLElement>('.sunrise-field')
  const canvas = container?.querySelector('canvas')
  const cta = section?.querySelector<HTMLElement>('.button')
  if (!section || !container || !canvas) return

  let width = 0
  let height = 0
  let progress = motion ? 0 : 1
  let sunX = 0
  let glow = 0
  let flare = 0
  let flareTarget = 0
  const pointer = { x: 0, y: 0, active: false }
  const light = { x: 0, y: 0 }
  // Sun geometry, recomputed once per frame instead of once per cell.
  const sun = { radius: 0, centerY: 0, lightAngle: 0, lightDistance: 0, rayLength: 0 }
  const updateSun = (time: number) => {
    sun.radius = Math.min(width * 0.16, 150) * (1 + 0.22 * flare + 0.02 * Math.sin(time * 2))
    sun.centerY = height + sun.radius * 1.35 - progress * sun.radius * (1.1 + 0.15 * glow)
    sun.lightAngle = Math.atan2(light.y - sun.centerY, light.x - sunX)
    sun.lightDistance = Math.hypot(light.x - sunX, light.y - sun.centerY)
    sun.rayLength = sun.radius * (2.2 + 1.4 * flare)
  }
  const ripples: { x: number; y: number; start: number }[] = []
  const RIPPLE_LIFE = 1.4
  const RIPPLE_SPEED = 460
  const TWO_PI = Math.PI * 2

  const field = createDitherField({
    canvas,
    palette: DITHER_PALETTE,
    pixelSize: 4,
    onResize: (nextWidth, nextHeight) => {
      width = nextWidth
      height = nextHeight
      sunX ||= width / 2
    },
    sample: (x, y, time) => {
      const { radius, centerY, rayLength } = sun
      const dx = x - sunX
      const dy = y - centerY
      const distance = Math.hypot(dx, dy)
      const rim = 14
      if (distance < radius - rim) return 1
      if (distance < radius) return 0.55 + (0.45 * (radius - distance)) / rim

      const outside = distance - radius
      let value = 0

      if (outside < rayLength || glow > 0.01) {
        const angle = Math.atan2(dy, dx)
        if (outside < rayLength) {
          const reach = radius * (0.5 + 0.08 * Math.sin(angle * 7 + time * 1.2) + 0.6 * flare)
          if (outside < reach) {
            const halo = 1 - outside / reach
            value = 0.4 * halo * halo
          }
          const raySin = Math.sin(angle * 12 + time * 0.4)
          if (raySin > 0) {
            const r2 = raySin * raySin
            const r4 = r2 * r2
            const ray = r4 * r4
            value = Math.max(value, ray * (0.3 + 0.3 * flare) * (1 - outside / rayLength))
          }
        }

        if (glow > 0.01) {
          const along = outside / Math.max(sun.lightDistance - radius + 80, 1)
          if (along < 1) {
            let delta = angle - sun.lightAngle
            if (delta > Math.PI) delta -= TWO_PI
            else if (delta < -Math.PI) delta += TWO_PI
            const normDelta = delta / 0.075
            const beam = Math.exp(-(normDelta * normDelta)) * (1 - along) ** 0.6
            value = Math.max(value, 0.62 * glow * beam)
          }
          const spotDx = x - light.x
          const spotDy = y - light.y
          const spotDistSq = spotDx * spotDx + spotDy * spotDy
          if (spotDistSq < 42000) {
            const spot = Math.exp(-spotDistSq / 6000)
            value = Math.max(value, 0.48 * glow * spot)
          }
        }
      }

      for (const ripple of ripples) {
        const age = time - ripple.start
        const ring = Math.abs(Math.hypot(x - ripple.x, y - ripple.y) - age * RIPPLE_SPEED)
        if (ring < 12) value = Math.max(value, (1 - ring / 12) * (1 - age / RIPPLE_LIFE) * 0.95)
      }
      return value
    },
  })

  new ResizeObserver(() => {
    field.resize()
    updateSun(0)
    field.render(0)
  }).observe(container)

  if (!motion) {
    updateSun(0)
    field.render(0)
    return
  }

  const toLocal = (event: PointerEvent) => {
    const origin = container.getBoundingClientRect()
    return { x: event.clientX - origin.left, y: event.clientY - origin.top }
  }
  section.addEventListener('pointermove', (event) => {
    Object.assign(pointer, toLocal(event), { active: true })
  })
  section.addEventListener('pointerleave', () => {
    pointer.active = false
  })
  section.addEventListener('pointerdown', (event) => {
    ripples.push({ ...toLocal(event), start: performance.now() / 1000 })
    if (ripples.length > 6) ripples.shift()
  })
  for (const [type, value] of [
    ['pointerenter', 1],
    ['pointerleave', 0],
    ['focus', 1],
    ['blur', 0],
  ] as const) {
    cta?.addEventListener(type, () => {
      flareTarget = value
    })
  }

  runWhileVisible(container, (time) => {
    // 0 when the section enters at the bottom of the viewport, 1 when its end reaches it.
    const bounds = section.getBoundingClientRect()
    const target = Math.min(Math.max((window.innerHeight - bounds.top) / bounds.height, 0), 1)
    progress += (target - progress) * 0.14
    const follow = pointer.active ? Math.min(Math.max(pointer.x, width * 0.25), width * 0.75) : width / 2
    sunX += (follow - sunX) * 0.06
    glow += ((pointer.active ? 1 : 0) - glow) * 0.08
    flare += (flareTarget - flare) * 0.12
    if (pointer.active) {
      light.x += (pointer.x - light.x) * 0.2
      light.y += (pointer.y - light.y) * 0.2
    }
    while (ripples.length && time - ripples[0].start > RIPPLE_LIFE) ripples.shift()
    updateSun(time)
    field.render(time)
  })
}

// The playground paints the same background as the window around it, so it
// loads in place without a loading screen.
function initShowcase(): void {
  const frame = document.querySelector<HTMLIFrameElement>('#showcase-frame')
  const stage = document.querySelector<HTMLElement>('#playground')
  if (!frame || !stage) return

  let started = false
  const load = () => {
    if (started) return
    started = true
    const source = frame.dataset.src
    if (source) frame.src = source
  }

  if (!('IntersectionObserver' in window)) {
    load()
    return
  }

  // Loads the playground when it gets close, and tells it whether it is on
  // screen so the live typing demo pauses while nobody can see it.
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((entry) => entry.isIntersecting)
      if (visible) load()
      frame.contentWindow?.postMessage({ type: 'gojs-showcase-visibility', visible }, window.location.origin)
    },
    { rootMargin: '180px 0px', threshold: 0.05 },
  )
  observer.observe(stage)
}

function initAgentDemo(): void {
  const frame = document.querySelector<HTMLIFrameElement>('#agent-demo-frame')
  const loader = document.querySelector<HTMLElement>('#agent-demo-loader')
  const stage = document.querySelector<HTMLElement>('.feature-ai')
  if (!frame || !loader || !stage) return

  let started = false
  const load = () => {
    if (started) return
    started = true
    const source = frame.dataset.src
    if (source) frame.src = source
  }

  const onReady = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return
    if (event.data?.type !== 'gojs-agent-demo-ready') return
    loader.classList.add('is-loaded')
    window.setTimeout(() => loader.setAttribute('hidden', ''), 260)
    window.removeEventListener('message', onReady)
  }
  window.addEventListener('message', onReady)

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
    { rootMargin: '240px 0px', threshold: 0.05 },
  )
  observer.observe(stage)
}

// Release assets have stable names, so these always point to the newest
// published desktop release (see docs/desktop-release.md).
const DOWNLOADS_URL = 'https://github.com/midudev/gojs/releases/latest/download'

type DesktopPlatform = 'macos' | 'macos-intel' | 'windows' | 'linux'

const DESKTOP_DOWNLOADS: Record<DesktopPlatform, { label: string; detail: string; asset: string }> = {
  macos: { label: 'Download for macOS', detail: 'Apple Silicon', asset: 'GoJS-macOS-arm64.dmg' },
  'macos-intel': { label: 'Download for macOS', detail: 'Intel', asset: 'GoJS-macOS-x64.dmg' },
  windows: { label: 'Download for Windows', detail: 'Windows x64 installer', asset: 'GoJS-Windows-x64-setup.exe' },
  linux: { label: 'Download for Linux', detail: 'x64 AppImage', asset: 'GoJS-Linux-x64.AppImage' },
}

interface UserAgentData {
  platform: string
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

async function detectDesktopPlatform(): Promise<DesktopPlatform | null> {
  const { userAgent, maxTouchPoints } = navigator
  const uaData = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  const platform = uaData?.platform || navigator.platform

  if (/Android|iPhone|iPad|iPod|CrOS/i.test(userAgent)) return null
  if (/Win/i.test(platform)) return 'windows'
  if (/Mac/i.test(platform)) {
    // iPadOS reports itself as a Mac; only real Macs have no multi-touch.
    if (maxTouchPoints > 1) return null
    // Only Chromium exposes the CPU. Everyone else gets Apple Silicon, the
    // only kind of Mac sold since 2023, with the Intel build one click away.
    const values = await uaData?.getHighEntropyValues?.(['architecture']).catch(() => undefined)
    return values?.architecture === 'x86' ? 'macos-intel' : 'macos'
  }
  if (/Linux/i.test(platform)) return 'linux'
  return null
}

async function initDownloads(): Promise<void> {
  const platform = await detectDesktopPlatform()
  if (!platform) return

  const download = DESKTOP_DOWNLOADS[platform]
  const url = `${DOWNLOADS_URL}/${download.asset}`

  for (const [ctaId, labelId] of [
    ['download-cta', 'download-label'],
    ['download-cta-bottom', 'download-label-bottom'],
  ]) {
    const cta = document.getElementById(ctaId)
    const label = document.getElementById(labelId)
    if (!(cta instanceof HTMLAnchorElement) || !label) continue
    cta.href = url
    cta.removeAttribute('target')
    cta.removeAttribute('rel')
    label.textContent = download.label
  }

  const meta = document.querySelector('#download-meta')
  if (meta) {
    const allDownloads = document.createElement('a')
    allDownloads.href = '#desktop'
    allDownloads.textContent = 'All downloads'
    meta.replaceChildren(`Free · ${download.detail} · `, allDownloads)
  }

  document.querySelector(`.platform-downloads a[href="${url}"]`)?.classList.add('is-recommended')
}

initHeader()
initHeroField()
initPixelLogos()
initSpecimens()
initSunrise()
initShowcase()
initAgentDemo()
void initDownloads()

export {}
