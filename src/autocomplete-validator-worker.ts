import { rankCandidateIndices } from './autocomplete-validation'

type ValidationRequest = {
  id: number
  code: string
  cursorOffset: number
  candidates: string[]
  language: string
}

type ValidationResult = {
  id: number
  rankedIndices: number[]
}

self.onmessage = (event: MessageEvent<ValidationRequest>) => {
  const { id, code, cursorOffset, candidates, language } = event.data
  const rankedIndices = rankCandidateIndices(code, cursorOffset, candidates, language)

  self.postMessage({ id, rankedIndices } satisfies ValidationResult)
}
