export interface ChatQueueSelection {
  text: string
  startLine: number
  endLine: number
  label: string
}

export interface ChatQueueItem {
  id: string
  message: string
  selection: ChatQueueSelection | null
}

export interface QueueRemoval {
  queue: ChatQueueItem[]
  item: ChatQueueItem | null
}

export function enqueueChatMessage(queue: ChatQueueItem[], item: ChatQueueItem): ChatQueueItem[] {
  return [...queue, item]
}

export function dequeueChatMessage(queue: ChatQueueItem[]): QueueRemoval {
  if (queue.length === 0) return { queue, item: null }
  return { queue: queue.slice(1), item: queue[0] }
}

export function removeQueuedMessage(queue: ChatQueueItem[], id: string): QueueRemoval {
  const index = queue.findIndex((item) => item.id === id)
  if (index === -1) return { queue, item: null }

  return {
    queue: [...queue.slice(0, index), ...queue.slice(index + 1)],
    item: queue[index],
  }
}

export function prioritizeQueuedMessage(queue: ChatQueueItem[], id: string): ChatQueueItem[] {
  const index = queue.findIndex((item) => item.id === id)
  if (index <= 0) return queue

  const prioritized = [...queue]
  ;[prioritized[index - 1], prioritized[index]] = [prioritized[index], prioritized[index - 1]]
  return prioritized
}

export function takeQueuedMessageForEdit(queue: ChatQueueItem[], id: string): QueueRemoval {
  return removeQueuedMessage(queue, id)
}
