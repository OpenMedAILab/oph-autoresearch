import type { ResearchEvent } from '@oph-autoresearch/core'
import type { Store } from './db.ts'

/** At-least-once delivery: mark only after publish. Consumers deduplicate campaign sequence. */
export function deliverResearchOutbox(
  store: Store,
  publish: (event: ResearchEvent) => void,
): number {
  return store.tx(() => {
    const rows = store.db
      .query<{ id: string; payload: string }, []>(
        `SELECT o.id, o.payload FROM research_outbox o
       JOIN research_events e ON e.id = o.event_id
       WHERE o.delivered_at IS NULL ORDER BY e.campaign_id, e.sequence`,
      )
      .all()
    for (const row of rows) {
      publish(JSON.parse(row.payload) as ResearchEvent)
      store.db
        .query('UPDATE research_outbox SET delivered_at = ? WHERE id = ?')
        .run(Date.now(), row.id)
    }
    return rows.length
  })
}
