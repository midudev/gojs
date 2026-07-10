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

/**
 * Calcula el diff línea a línea entre `oldCode` y `newCode` usando la
 * subsecuencia común más larga (LCS). Devuelve el número de líneas añadidas y
 * eliminadas junto con la secuencia de líneas etiquetadas para pintar el diff.
 */
export function computeLineDiff(oldCode: string, newCode: string): CodeDiff {
  const a = oldCode.length ? oldCode.split('\n') : []
  const b = newCode.length ? newCode.split('\n') : []
  const m = a.length
  const n = b.length

  // Tabla LCS (longitud de subsecuencia común) desde el final.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', text: a[i], oldLine: oldNo++, newLine: newNo++ })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i], oldLine: oldNo++ })
      i++
      removed++
    } else {
      lines.push({ type: 'add', text: b[j], newLine: newNo++ })
      j++
      added++
    }
  }
  while (i < m) {
    lines.push({ type: 'del', text: a[i], oldLine: oldNo++ })
    i++
    removed++
  }
  while (j < n) {
    lines.push({ type: 'add', text: b[j], newLine: newNo++ })
    j++
    added++
  }

  return { added, removed, lines }
}
