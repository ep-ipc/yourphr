/**
 * The chat page's state (yourphr#594), driven directly against a stub service.
 *
 * Deliberately NOT a TestBed component spec. The karma suite in this repo cannot currently create
 * components at all — every `createComponent` call fails with NG0402 regardless of the component,
 * including specs that predate this feature — so a component spec here would be 5 more entries in
 * a pile of failures that proves nothing. This exercises the same logic through the class the
 * component is a thin view over, and it runs.
 */
import { of, throwError } from 'rxjs';
import { ChatStateService } from './chat-state.service';
import type { ChatAnswer, ChatConversation, ChatMessage, ChatService, ChatStatus } from '../../services/chat.service';

class StubChatService {
  statusValue: ChatStatus = { available: true, reason: '', indexed: 3, indexing: false };
  conversationsValue: ChatConversation[] = [];
  messagesValue: ChatMessage[] = [];
  answer: ChatAnswer = { conversationId: 'conv-1', answer: 'You take Lisinopril.', citations: [] };
  askError: unknown = null;
  asked: { message: string; conversationId?: string }[] = [];
  forgotten: string[] = [];

  status() { return of(this.statusValue); }
  conversations() { return of(this.conversationsValue); }
  messages() { return of(this.messagesValue); }
  ask(message: string, conversationId?: string) {
    this.asked.push({ message, conversationId });
    return this.askError ? throwError(() => this.askError) : of(this.answer);
  }
  forget(conversationId: string) { this.forgotten.push(conversationId); return of(true); }
}

describe('ChatStateService', () => {
  let stub: StubChatService;
  let state: ChatStateService;

  beforeEach(() => {
    stub = new StubChatService();
    state = new ChatStateService(stub as unknown as ChatService);
  });

  it('sends a question and appends the answer', async () => {
    await state.send('what am I taking?');
    expect(stub.asked).toEqual([{ message: 'what am I taking?', conversationId: undefined }]);
    expect(state.messages.value.map((m) => [m.sender, m.text])).toEqual([
      ['user', 'what am I taking?'],
      ['bot', 'You take Lisinopril.'],
    ]);
    expect(state.currentConversationId.value).toBe('conv-1');
    expect(state.awaiting.value).toBeFalse();
  });

  it('carries the conversation id into the next question', async () => {
    await state.send('first');
    await state.send('second');
    expect(stub.asked[1]).toEqual({ message: 'second', conversationId: 'conv-1' });
  });

  it('ignores an empty question, and one sent while an answer is outstanding', async () => {
    await state.send('   ');
    expect(stub.asked).toEqual([]);
    state.awaiting.next(true);
    await state.send('too soon');
    expect(stub.asked).toEqual([]);
  });

  it('puts a failure in the transcript, using the server’s own sentence', async () => {
    stub.askError = { error: { error: 'the assistant could not answer: model timed out' } };
    await state.send('anything?');
    const last = state.messages.value[state.messages.value.length - 1];
    expect(last.failed).toBeTrue();
    expect(last.text).toContain('model timed out');
    // The question stays visible: losing what was asked is worse than showing a failed answer.
    expect(state.messages.value[0].text).toBe('anything?');
    expect(state.awaiting.value).toBeFalse();
  });

  it('falls back to a plain sentence when the failure carries none', async () => {
    stub.askError = {};
    await state.send('anything?');
    expect(state.messages.value[1].text).toBe('the assistant could not be reached');
  });

  it('reports an unreachable instance as unavailable rather than throwing', async () => {
    stub.status = () => throwError(() => ({ error: { error: 'sidecar is down' } }));
    await state.refreshStatus();
    expect(state.status.value).toEqual({ available: false, reason: 'sidecar is down', indexed: 0, indexing: false });
  });

  it('clears the open transcript when a new conversation starts', async () => {
    await state.send('first');
    state.newConversation();
    expect(state.messages.value).toEqual([]);
    expect(state.currentConversationId.value).toBeUndefined();
  });

  it('loads a conversation’s turns, oldest first, mapped to the page’s shape', async () => {
    stub.messagesValue = [
      { role: 'user', message: 'hello', at: 1 },
      { role: 'assistant', message: 'hi', at: 2 },
    ];
    await state.selectConversation('conv-9');
    expect(state.currentConversationId.value).toBe('conv-9');
    expect(state.messages.value.map((m) => m.sender)).toEqual(['user', 'bot']);
  });

  it('leaves the open conversation alone when a different one is deleted', async () => {
    await state.send('first');
    await state.deleteConversation('other');
    expect(stub.forgotten).toEqual(['other']);
    expect(state.currentConversationId.value).toBe('conv-1');
  });

  it('clears the page when the open conversation is the one deleted', async () => {
    await state.send('first');
    await state.deleteConversation('conv-1');
    expect(state.currentConversationId.value).toBeUndefined();
    expect(state.messages.value).toEqual([]);
  });
});
