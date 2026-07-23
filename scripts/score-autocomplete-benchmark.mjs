import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'acorn'
import { transform } from 'sucrase'

const resultsPath = process.argv.slice(2).find((argument) => argument !== '--')
if (!resultsPath) {
  console.error('Usage: pnpm benchmark:autocomplete -- <results.json>')
  process.exit(1)
}

const root = new URL('..', import.meta.url)
const cases = JSON.parse(readFileSync(new URL('benchmarks/autocomplete-cases.json', root), 'utf8'))
const report = JSON.parse(readFileSync(resultsPath === '-' ? 0 : resolve(resultsPath), 'utf8'))
const results = Array.isArray(report) ? report : report.results
const byId = new Map(results.map((result) => [result.id, result]))

function normalize(value) {
  return value.replace(/\r\n?/g, '\n').trim().replace(/[ \t]+/g, ' ')
}

function editSimilarity(left, right) {
  const a = normalize(left)
  const b = normalize(right)
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    let diagonal = row[0]
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      const previous = row[rightIndex]
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (a[leftIndex - 1] === b[rightIndex - 1] ? 0 : 1),
      )
      diagonal = previous
    }
  }
  return 1 - row[b.length] / Math.max(1, a.length, b.length)
}

function parses(testCase, completion) {
  try {
    const source = `${testCase.prefix}${completion}${testCase.suffix}`
    const javascript =
      testCase.language === 'typescript'
        ? transform(source, { transforms: ['typescript'], disableESTransforms: true }).code
        : source
    parse(javascript, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
    return true
  } catch {
    return false
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]
}

const scored = cases.map((testCase) => {
  const result = byId.get(testCase.id) ?? { completion: '' }
  const completion = result.completion ?? ''
  return {
    id: testCase.id,
    exact: normalize(completion) === normalize(testCase.expected),
    similarity: editSimilarity(completion, testCase.expected),
    parses: parses(testCase, completion),
    prose: /^\s*(?:here|sure|the completion)/i.test(completion),
    ttftMs: result.ttftMs,
    totalMs: result.totalMs,
  }
})

const average = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const ttft = scored.map((result) => result.ttftMs).filter(Number.isFinite)
const total = scored.map((result) => result.totalMs).filter(Number.isFinite)
const summary = {
  harness: report.harness ?? 'unknown',
  cases: scored.length,
  exactMatchRate: average(scored.map((result) => Number(result.exact))),
  averageSimilarity: average(scored.map((result) => result.similarity)),
  parseRate: average(scored.map((result) => Number(result.parses))),
  proseRate: average(scored.map((result) => Number(result.prose))),
  ttftP50Ms: percentile(ttft, 0.5),
  ttftP95Ms: percentile(ttft, 0.95),
  totalP50Ms: percentile(total, 0.5),
  totalP95Ms: percentile(total, 0.95),
}

console.log(JSON.stringify({ summary, cases: scored }, null, 2))
