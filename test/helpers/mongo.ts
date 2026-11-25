import type { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Payload } from 'payload'

/** Destroys every instance, one failing destroy never skipping the rest, and then stops the server and removes its data folder. Returns what went wrong. */
export async function closeAll(payloads: (Payload | undefined)[], mongo: MongoMemoryReplSet | undefined): Promise<string[]> {
  const problems: string[] = []
  try {
    for (const p of payloads) {
      try {
        await p?.destroy()
      } catch (e) {
        problems.push(`destroy: ${(e as Error).message}`)
      }
    }
  } finally {
    try {
      await mongo?.stop({ doCleanup: true, force: true })
    } catch (e) {
      problems.push(`stop: ${(e as Error).message}`)
    }
  }
  return problems
}
