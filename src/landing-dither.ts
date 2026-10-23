// Ordered (Bayer 8×8) dithering for the landing page canvases.
const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54,
  22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29,
  53, 21,
]
const THRESHOLDS = Float32Array.from(BAYER_8, (value) => (value + 0.5) / 64)

type Rgba = [number, number, number, number]

function parseColor(color: string): Rgba {
  if (color === 'transparent') return [0, 0, 0, 0]
  const hex = color.replace('#', '')
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255]
}

export interface DitherFieldOptions {
  canvas: HTMLCanvasElement
  /** Colors from the lowest to the highest intensity. 'transparent' lets the page show through. */
  palette: string[]
  /** Size of one dither cell in CSS pixels. */
  pixelSize: number
  /** Intensity in [0, 1] at a point, in CSS pixels from the canvas origin. */
  sample: (x: number, y: number, time: number) => number
  /** Runs after every resize with the CSS size of the canvas container. */
  onResize?: (width: number, height: number) => void
}

export interface DitherField {
  render: (time: number) => void
  resize: () => void
}

/**
 * Paints an intensity field with a fixed palette. The canvas has one pixel per
 * cell and is scaled up with `image-rendering: pixelated`, so every cell stays
 * an exact square at any device pixel ratio.
 */
export function createDitherField({ canvas, palette, pixelSize, sample, onResize }: DitherFieldOptions): DitherField {
  const context = canvas.getContext('2d')
  const colors = palette.map(parseColor)
  const colors32 = Uint32Array.from(colors, (rgba) => new Uint32Array(new Uint8ClampedArray(rgba).buffer)[0])
  const color0 = colors32[0]
  const levels = colors.length - 1
  let image: ImageData | null = null
  let pixels: Uint32Array | null = null

  const resize = () => {
    const container = canvas.parentElement ?? canvas
    const { width, height } = container.getBoundingClientRect()
    const columns = Math.max(1, Math.ceil(width / pixelSize))
    const rows = Math.max(1, Math.ceil(height / pixelSize))
    if (context && (canvas.width !== columns || canvas.height !== rows || !image)) {
      canvas.width = columns
      canvas.height = rows
      canvas.style.width = `${columns * pixelSize}px`
      canvas.style.height = `${rows * pixelSize}px`
      image = context.createImageData(columns, rows)
      pixels = new Uint32Array(image.data.buffer)
    }
    onResize?.(width, height)
  }

  const render = (time: number) => {
    if (!context || !image || !pixels) return
    const { width, height } = image
    let pixelIndex = 0
    for (let row = 0; row < height; row++) {
      const y = (row + 0.5) * pixelSize
      const rowThresholdOffset = (row & 7) << 3
      for (let column = 0; column < width; column++) {
        const intensity = sample((column + 0.5) * pixelSize, y, time)
        if (intensity <= 0) {
          pixels[pixelIndex++] = color0
          continue
        }
        const scaled = (intensity >= 1 ? 1 : intensity) * levels
        const base = Math.min(scaled | 0, levels - 1)
        const index = scaled - base > THRESHOLDS[rowThresholdOffset | (column & 7)] ? base + 1 : base
        pixels[pixelIndex++] = colors32[index]
      }
    }
    context.putImageData(image, 0, 0)
  }

  resize()
  return { render, resize }
}

/**
 * Calls `frame` at most `fps` times per second while `target` is on screen and
 * the tab is visible. Returns a function that stops the loop.
 */
export function runWhileVisible(target: Element, frame: (time: number) => void, fps = 30): () => void {
  let visible = false
  let handle = 0
  let last = 0
  const interval = 1000 / fps

  const tick = (now: number) => {
    handle = requestAnimationFrame(tick)
    if (now - last < interval) return
    last = now
    frame(now / 1000)
  }
  const update = () => {
    const shouldRun = visible && document.visibilityState === 'visible'
    if (shouldRun && !handle) handle = requestAnimationFrame(tick)
    if (!shouldRun && handle) {
      cancelAnimationFrame(handle)
      handle = 0
    }
  }

  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting)
    update()
  })
  observer.observe(target)
  document.addEventListener('visibilitychange', update)

  return () => {
    observer.disconnect()
    document.removeEventListener('visibilitychange', update)
    visible = false
    update()
  }
}

/**
 * Draws an image as dithered blocks of `block` CSS pixels: RGB is reduced to a
 * few levels per channel and the alpha edge becomes a hard pixel stair. A block
 * of 1 draws the original image.
 */
export function createPixelImage(canvas: HTMLCanvasElement, source: HTMLImageElement): (block: number) => void {
  const context = canvas.getContext('2d')
  const buffer = document.createElement('canvas')
  const bufferContext = buffer.getContext('2d', { willReadFrequently: true })
  const channelLevels = 5

  return (block: number) => {
    if (!context || !bufferContext) return
    const ratio = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    const targetWidth = Math.round(width * ratio)
    const targetHeight = Math.round(height * ratio)
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
    }
    context.clearRect(0, 0, targetWidth, targetHeight)

    if (block <= 1) {
      context.imageSmoothingEnabled = true
      context.drawImage(source, 0, 0, targetWidth, targetHeight)
      return
    }

    const columns = Math.max(1, Math.ceil(width / block))
    const rows = Math.max(1, Math.ceil(height / block))
    buffer.width = columns
    buffer.height = rows
    bufferContext.clearRect(0, 0, columns, rows)
    bufferContext.drawImage(source, 0, 0, columns, rows)
    const image = bufferContext.getImageData(0, 0, columns, rows)
    const { data } = image
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const threshold = THRESHOLDS[((row & 7) << 3) | (column & 7)]
        const offset = (row * columns + column) * 4
        for (let channel = 0; channel < 3; channel++) {
          const scaled = (data[offset + channel] / 255) * channelLevels
          const base = Math.floor(scaled)
          data[offset + channel] =
            (Math.min(scaled - base > threshold ? base + 1 : base, channelLevels) * 255) / channelLevels
        }
        data[offset + 3] = data[offset + 3] / 255 > threshold ? 255 : 0
      }
    }
    bufferContext.putImageData(image, 0, 0)
    context.imageSmoothingEnabled = false
    context.drawImage(buffer, 0, 0, columns * block * ratio, rows * block * ratio)
  }
}
