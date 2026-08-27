/** An in-memory chat provider for the manager's tests (yourphr#594). No sidecar, no model. */
import { BaseChatProvider, type ChatAnswer, type ChatConversation, type ChatMessage } from '../BaseChatProvider.js';

export class FakeChatProvider extends BaseChatProvider {
  readonly name = 'fake';
  available = true;
  readonly unavailableReason = '';

  /** Questions asked, with the account they were asked for. */
  readonly asked: { userId: string; question: string; conversationId?: string }[] = [];
  initializeCalled = 0;
  /** Set to make initialize() throw, standing in for a sidecar that is down. */
  failInitialize = '';
  /** Set to make ask() throw, standing in for a model that did not answer. */
  failAsk = '';

  private readonly owners = new Map<string, string>();
  private readonly transcripts = new Map<string, ChatMessage[]>();
  private next = 1;

  override async initialize(): Promise<void> {
    this.initializeCalled++;
    if (this.failInitialize !== '') throw new Error(this.failInitialize);
  }

  override async ask(userId: string, question: string, conversationId?: string): Promise<ChatAnswer> {
    if (this.failAsk !== '') throw new Error(this.failAsk);
    if (conversationId !== undefined && this.owners.get(conversationId) !== userId) {
      throw new Error('conversation not found');
    }
    const id = conversationId ?? `conv-${this.next++}`;
    this.owners.set(id, userId);
    this.asked.push({ userId, question, ...(conversationId === undefined ? {} : { conversationId }) });
    const turns = this.transcripts.get(id) ?? [];
    turns.push({ role: 'user', message: question, at: turns.length });
    turns.push({ role: 'assistant', message: `answer to ${question}`, at: turns.length });
    this.transcripts.set(id, turns);
    return { conversationId: id, answer: `answer to ${question}`, citations: [] };
  }

  override async conversations(userId: string): Promise<ChatConversation[]> {
    return [...this.owners.entries()]
      .filter(([, owner]) => owner === userId)
      .map(([id]) => ({ id, firstMessage: this.transcripts.get(id)?.[0]?.message ?? '', at: 0 }));
  }

  override async messages(userId: string, conversationId: string): Promise<ChatMessage[]> {
    if (this.owners.get(conversationId) !== userId) return [];
    return this.transcripts.get(conversationId) ?? [];
  }

  override async forget(userId: string, conversationId: string): Promise<boolean> {
    if (this.owners.get(conversationId) !== userId) return false;
    this.owners.delete(conversationId);
    this.transcripts.delete(conversationId);
    return true;
  }

  override async removeAll(userId: string): Promise<void> {
    for (const [id, owner] of [...this.owners.entries()]) {
      if (owner === userId) { this.owners.delete(id); this.transcripts.delete(id); }
    }
  }
}
