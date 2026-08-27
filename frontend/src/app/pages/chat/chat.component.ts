/** The chat page (yourphr#594). All state lives in ChatStateService; this is the view over it. */
import { Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { ChatStateService, type Message } from './chat-state.service';
import type { ChatConversation, ChatStatus } from '../../services/chat.service';

@Component({
  standalone: false,
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
})
export class ChatComponent implements OnInit {
  userMessage = '';
  messages: Observable<Message[]>;
  conversations: Observable<ChatConversation[]>;
  currentConversationId: Observable<string | undefined>;
  awaiting: Observable<boolean>;
  status: Observable<ChatStatus | undefined>;

  constructor(public chatStateService: ChatStateService) {
    this.messages = this.chatStateService.messages.asObservable();
    this.conversations = this.chatStateService.conversations.asObservable();
    this.currentConversationId = this.chatStateService.currentConversationId.asObservable();
    this.awaiting = this.chatStateService.awaiting.asObservable();
    this.status = this.chatStateService.status.asObservable();
  }

  ngOnInit(): void {
    // Status first: it is also what starts the backfill for an account whose records predate the
    // feature being switched on, so asking early means fewer "I don't have enough information".
    void this.chatStateService.refreshStatus();
    void this.chatStateService.loadConversations();
  }

  async sendMessage(): Promise<void> {
    const text = this.userMessage;
    this.userMessage = '';
    await this.chatStateService.send(text);
  }

  newConversation(): void { this.chatStateService.newConversation(); }
  selectConversation(id: string): void { void this.chatStateService.selectConversation(id); }
  deleteConversation(id: string): void { void this.chatStateService.deleteConversation(id); }
}
