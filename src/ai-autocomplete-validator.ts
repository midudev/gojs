// @ts-ignore
import AutocompleteValidatorWorker from './autocomplete-validator-worker?worker'

type PendingValidation = {
  resolve: (indices: number[]) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let requestSequence = 0
const pending = new Map<number, PendingValidation>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new AutocompleteValidatorWorker()
  worker.onmessage = (event: MessageEvent<{ id: number; rankedIndices: number[] }>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    request.resolve(event.data.rankedIndices)
  }
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error('Autocomplete validation worker failed'))
    pending.clear()
  }
  return worker
}

export async function rankAutocompleteCandidates(
  code: string,
  cursorOffset: number,
  candidates: string[],
  language: string,
): Promise<string[]> {
  if (candidates.length === 0) return candidates
  const id = ++requestSequence
  const rankedIndices = await new Promise<number[]>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, code, cursorOffset, candidates, language })
  }).catch(() => candidates.map((_, index) => index))
  return rankedIndices.map((index) => candidates[index]).filter((candidate): candidate is string => Boolean(candidate))
}

export function destroyAutocompleteValidator(): void {
  worker?.terminate()
  worker = null
  for (const request of pending.values()) request.reject(new Error('Autocomplete validator destroyed'))
  pending.clear()
}
