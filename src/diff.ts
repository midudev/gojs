/**
 * Diff por líneas (basado en LCS). Módulo puro y sin dependencias de UI, para
 * poder reutilizarlo tanto en el agente (tarjetas de edición) como en el
 * historial de versiones, y testearlo de forma aislada.
 */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  /** Número de línea en el archivo antiguo (para 'del' y 'ctx'). */
  oldLine?: number
  /** Número de línea en el archivo nuevo (para 'add' y 'ctx'). */
  newLine?: number
}

export interface CodeDiff {
  added: number
  removed: number
  lines: DiffLine[]
}

// Calcula la última fila de la tabla LCS entre a[aOff, aOff+aLen) y b[bOff, bOff+bLen)
// usando solo dos filas (memoria O(bLen)). Con `reversed` recorre ambos rangos desde
// el final, que es lo que necesita Hirschberg para la mitad derecha.
function lcsLastRow(
  a: string[],
  aOff: number,
  aLen: number,
  b: string[],
  bOff: number,
  bLen: number,
  reversed: boolean,
): number[] {
  let prev = new Array<number>(bLen + 1).fill(0)
  let curr = new Array<number>(bLen + 1).fill(0)

  for (let i = 1; i <= aLen; i++) {
    const ai = reversed ? a[aOff + aLen - i] : a[aOff + i - 1]
    curr[0] = 0
    for (let j = 1; j <= bLen; j++) {
      const bj = reversed ? b[bOff + bLen - j] : b[bOff + j - 1]
      if (ai === bj) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1]
      }
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }

  return prev
}

// Devuelve los pares (i, j) de líneas coincidentes que forman una LCS, en orden
// creciente, usando el algoritmo de Hirschberg: memoria lineal O(min longitudes)
// en vez de la tabla completa O(m·n) del LCS clásico.
function lcsMatchPairs(a: string[], b: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []

  const rec = (aOff: number, aLen: number, bOff: number, bLen: number) => {
    if (aLen === 0 || bLen === 0) return

    if (aLen === 1) {
      const target = a[aOff]
      for (let j = 0; j < bLen; j++) {
        if (b[bOff + j] === target) {
          pairs.push([aOff, bOff + j])
          return
        }
      }
      return
    }

    const aMid = aLen >> 1
    const left = lcsLastRow(a, aOff, aMid, b, bOff, bLen, false)
    const right = lcsLastRow(a, aOff + aMid, aLen - aMid, b, bOff, bLen, true)

    // Elegir el corte de b que maximiza la LCS combinada de ambas mitades.
    let best = -1
    let bestK = 0
    for (let k = 0; k <= bLen; k++) {
      const score = left[k] + right[bLen - k]
      if (score > best) {
        best = score
        bestK = k
      }
    }

    rec(aOff, aMid, bOff, bestK)
    rec(aOff + aMid, aLen - aMid, bOff + bestK, bLen - bestK)
  }

  rec(0, a.length, 0, b.length)
  return pairs
}

/**
 * Calcula el diff línea a línea entre `oldCode` y `newCode` usando la
 * subsecuencia común más larga (LCS). Devuelve el número de líneas añadidas y
 * eliminadas junto con la secuencia de líneas etiquetadas para pintar el diff.
 *
 * Implementación con memoria acotada: primero recorta prefijo/sufijo común (lo
 * habitual en ediciones localizadas) y solo aplica Hirschberg —memoria lineal—
 * sobre la región central que realmente difiere.
 */
export function computeLineDiff(oldCode: string, newCode: string): CodeDiff {
  const a = oldCode.length ? oldCode.split('\n') : []
  const b = newCode.length ? newCode.split('\n') : []
  const m = a.length
  const n = b.length

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let oldNo = 1
  let newNo = 1

  // Prefijo común: emitir como contexto y no procesarlo con LCS.
  let prefix = 0
  while (prefix < m && prefix < n && a[prefix] === b[prefix]) {
    prefix++
  }
  for (let k = 0; k < prefix; k++) {
    lines.push({ type: 'ctx', text: a[k], oldLine: oldNo++, newLine: newNo++ })
  }

  // Sufijo común (sin solaparse con el prefijo ya consumido).
  let suffix = 0
  while (suffix < m - prefix && suffix < n - prefix && a[m - 1 - suffix] === b[n - 1 - suffix]) {
    suffix++
  }

  // Región central que difiere.
  const aMidStart = prefix
  const aMidEnd = m - suffix
  const bMidStart = prefix
  const bMidEnd = n - suffix
  const aMid = a.slice(aMidStart, aMidEnd)
  const bMid = b.slice(bMidStart, bMidEnd)

  const pairs = lcsMatchPairs(aMid, bMid)

  let i = 0
  let j = 0
  for (const [mi, mj] of pairs) {
    while (i < mi) {
      lines.push({ type: 'del', text: aMid[i], oldLine: oldNo++ })
      i++
      removed++
    }
    while (j < mj) {
      lines.push({ type: 'add', text: bMid[j], newLine: newNo++ })
      j++
      added++
    }
    lines.push({ type: 'ctx', text: aMid[mi], oldLine: oldNo++, newLine: newNo++ })
    i = mi + 1
    j = mj + 1
  }
  while (i < aMid.length) {
    lines.push({ type: 'del', text: aMid[i], oldLine: oldNo++ })
    i++
    removed++
  }
  while (j < bMid.length) {
    lines.push({ type: 'add', text: bMid[j], newLine: newNo++ })
    j++
    added++
  }

  // Sufijo común como contexto.
  for (let k = suffix; k > 0; k--) {
    lines.push({ type: 'ctx', text: a[m - k], oldLine: oldNo++, newLine: newNo++ })
  }

  return { added, removed, lines }
}
