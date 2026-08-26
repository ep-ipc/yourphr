/**
 * The event stream (yourphr#594): the Sources page opens GET /api/secure/events/stream and reads
 * server-sent events to show a sync in progress — `source_sync` when one starts, `source_complete`
 * when it ends, `keep_alive` so a proxy does not drop the idle connection. Go's shapes, verbatim.
 *
 * Per user: a listener only ever receives events for the account that opened the stream. The bus
 * is in-memory and process-local, like Go's — a restart drops listeners, and the page reconnects.
 */
export type EventType = 'keep_alive' | 'source_sync' | 'source_complete';

export interface SourceEvent {
  event_type: EventType;
  source_id?: string;
}

export type Listener = (event: SourceEvent) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, listener: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  publish(userId: string, event: SourceEvent): void {
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
  }

  listenerCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}

/** One SSE frame, the way Go's c.SSEvent("message", ...) writes it. */
export function sseFrame(event: SourceEvent): string {
  return `event:message\ndata:${JSON.stringify(event)}\n\n`;
}
