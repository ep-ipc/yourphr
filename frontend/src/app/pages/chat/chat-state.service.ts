/**
 * What the chat page is currently showing (yourphr#594): the conversation list, the open
 * transcript, and whether an answer is on its way.
 *
 * The state lives here rather than in the component so a half-finished exchange survives the page
 * being navigated away from and back — a model can take a while, and losing the question because
 * somebody clicked a record is a bad way to find that out.
 */
import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { ChatService, type ChatConversation, type ChatStatus } from '../../services/chat.service';

export interface Message {
  text: string;
  sender: 'user' | 'bot';
  /** A message the server has not answered yet, or one that failed — rendered differently. */
  pending?: boolean;
  failed?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ChatStateService {
  messages = new BehaviorSubject<Message[]>([]);
  conversations = new BehaviorSubject<ChatConversation[]>([]);
  currentConversationId = new BehaviorSubject<string | undefined>(undefined);
  /** True while an answer is outstanding — the send button and the typing indicator read it. */
  awaiting = new BehaviorSubject<boolean>(false);
  status = new BehaviorSubject<ChatStatus | undefined>(undefined);

  constructor(private chat: ChatService) {}

  async refreshStatus(): Promise<void> {
    try {
      this.status.next(await firstValueFrom(this.chat.status()));
    } catch (err) {
      this.status.next({ available: false, reason: describe(err), indexed: 0, indexing: false });
    }
  }

  async loadConversations(): Promise<void> {
    try {
      this.conversations.next(await firstValueFrom(this.chat.conversations()));
    } catch {
      // An empty list is the honest fallback: the page still works for a new question, and the
      // failure is already visible in the status banner rather than as a second red message.
      this.conversations.next([]);
    }
  }

  async selectConversation(conversationId: string): Promise<void> {
    this.currentConversationId.next(conversationId);
    this.messages.next([]);
    try {
      const turns = await firstValueFrom(this.chat.messages(conversationId));
      this.messages.next(turns.map((t) => ({ text: t.message, sender: t.role === 'assistant' ? 'bot' : 'user' })));
    } catch (err) {
      this.messages.next([{ text: `This conversation could not be loaded: ${describe(err)}`, sender: 'bot', failed: true }]);
    }
  }

  newConversation(): void {
    this.currentConversationId.next(undefined);
    this.messages.next([]);
  }

  /** Send one question and append the answer. The optimistic turn is replaced, not duplicated. */
  async send(text: string): Promise<void> {
    const question = text.trim();
    if (question === '' || this.awaiting.value) return;

    this.messages.next([...this.messages.value, { text: question, sender: 'user' }, { text: '', sender: 'bot', pending: true }]);
    this.awaiting.next(true);
    try {
      const answer = await firstValueFrom(this.chat.ask(question, this.currentConversationId.value));
      this.replaceLast({ text: answer.answer, sender: 'bot' });
      if (this.currentConversationId.value !== answer.conversationId) {
        this.currentConversationId.next(answer.conversationId);
        await this.loadConversations();
      }
    } catch (err) {
      // Said out loud, in the transcript, where the question is. A chat that silently drops an
      // answer looks identical to a model that had nothing to say.
      this.replaceLast({ text: describe(err), sender: 'bot', failed: true });
    } finally {
      this.awaiting.next(false);
    }
  }

  async deleteConversation(conversationId: string): Promise<void> {
    try {
      await firstValueFrom(this.chat.forget(conversationId));
    } catch {
      // Fall through to the refresh: if it did go, the list will say so.
    }
    if (this.currentConversationId.value === conversationId) this.newConversation();
    await this.loadConversations();
  }

  private replaceLast(message: Message): void {
    const messages = [...this.messages.value];
    messages[messages.length - 1] = message;
    this.messages.next(messages);
  }
}

/** The server's own sentence where there is one; a plain one where there is not. */
function describe(err: unknown): string {
  const wrapped = (err as { error?: { error?: string } })?.error?.error;
  if (typeof wrapped === 'string' && wrapped !== '') return wrapped;
  const message = (err as { message?: string })?.message;
  return typeof message === 'string' && message !== '' ? message : 'the assistant could not be reached';
}
