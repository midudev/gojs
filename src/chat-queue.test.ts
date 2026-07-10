import { describe, expect, it } from 'vitest'
import {
  dequeueChatMessage,
  enqueueChatMessage,
  prioritizeQueuedMessage,
  removeQueuedMessage,
  takeQueuedMessageForEdit,
  type ChatQueueItem,
} from './chat-queue'

const first: ChatQueueItem = {
  id: 'first',
  message: 'Explain the output',
  selection: {
    text: 'console.log(answer)',
    startLine: 4,
    endLine: 4,
    label: 'main.js',
  },
}

const second: ChatQueueItem = {
  id: 'second',
  message: 'Now simplify it',
  selection: null,
}

const third: ChatQueueItem = {
  id: 'third',
  message: 'Add a test',
  selection: null,
}

describe('chat queue', () => {
  it('enqueues and dequeues messages in FIFO order without mutating the queue', () => {
    const empty: ChatQueueItem[] = []
    const withFirst = enqueueChatMessage(empty, first)
    const queue = enqueueChatMessage(withFirst, second)

    expect(empty).toEqual([])
    expect(withFirst).toEqual([first])
    expect(queue).toEqual([first, second])

    const result = dequeueChatMessage(queue)
    expect(result.item).toBe(first)
    expect(result.queue).toEqual([second])
    expect(queue).toEqual([first, second])
  })

  it('returns an unchanged empty queue when there is nothing to dequeue', () => {
    const queue: ChatQueueItem[] = []
    expect(dequeueChatMessage(queue)).toEqual({ queue, item: null })
  })

  it('takes an item for editing while preserving its message and selection', () => {
    const result = takeQueuedMessageForEdit([first, second], first.id)

    expect(result.item).toEqual(first)
    expect(result.item?.selection?.label).toBe('main.js')
    expect(result.queue).toEqual([second])
  })

  it('moves a queued message up exactly one position', () => {
    const queue = [first, second, third]

    expect(prioritizeQueuedMessage(queue, third.id)).toEqual([first, third, second])
    expect(prioritizeQueuedMessage(queue, first.id)).toBe(queue)
    expect(queue).toEqual([first, second, third])
  })

  it('removes only the requested queued message', () => {
    const queue = [first, second, third]
    const result = removeQueuedMessage(queue, second.id)

    expect(result.item).toBe(second)
    expect(result.queue).toEqual([first, third])
    expect(queue).toEqual([first, second, third])
  })

  it('leaves the queue unchanged when an id does not exist', () => {
    const queue = [first, second]
    const result = removeQueuedMessage(queue, 'missing')

    expect(result.item).toBeNull()
    expect(result.queue).toBe(queue)
    expect(prioritizeQueuedMessage(queue, 'missing')).toBe(queue)
  })
})
