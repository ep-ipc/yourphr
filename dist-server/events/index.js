export class EventBus {
    listeners = new Map();
    subscribe(userId, listener) {
        let set = this.listeners.get(userId);
        if (!set) {
            set = new Set();
            this.listeners.set(userId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0)
                this.listeners.delete(userId);
        };
    }
    publish(userId, event) {
        for (const listener of this.listeners.get(userId) ?? [])
            listener(event);
    }
    listenerCount(userId) {
        return this.listeners.get(userId)?.size ?? 0;
    }
}
/** One SSE frame, the way Go's c.SSEvent("message", ...) writes it. */
export function sseFrame(event) {
    return `event:message\ndata:${JSON.stringify(event)}\n\n`;
}
//# sourceMappingURL=index.js.map