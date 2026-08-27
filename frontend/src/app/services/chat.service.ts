/**
 * Chat (yourphr#594) — the browser's side of it.
 *
 * The browser talks to this instance and nothing else. It holds no search client and no key, and
 * the session cookie is what identifies the asker — the same way every other call on this page
 * works.
 *
 * That is worth stating because the Go implementation this replaces did the opposite: the browser
 * held a search engine's API key, handed to it in plaintext by an unauthenticated endpoint, and
 * queried that engine directly with no owner filter on either the retrieval or the conversation
 * list. On an instance with more than one account, one member's question could reach another
 * member's records.
 */
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { GetEndpointAbsolutePath } from '../../lib/utils/endpoint_absolute_path';
import { ResponseWrapper } from '../models/response-wrapper';

/** Whether chat can answer at all. There is no index, so there is nothing else to report. */
export interface ChatStatus {
  available: boolean;
  /** Why not, when `available` is false. Shown to the person rather than swallowed. */
  reason: string;
}

export interface ChatCitation {
  resourceType: string;
  resourceId: string;
  sourceId: string;
  title: string;
}

export interface ChatAnswer {
  conversationId: string;
  answer: string;
  citations: ChatCitation[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  message: string;
  at: number;
}

export interface ChatConversation {
  id: string;
  firstMessage: string;
  at: number;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  constructor(private _httpClient: HttpClient) {}

  private base(): string {
    return `${GetEndpointAbsolutePath(globalThis.location, environment.fasten_api_endpoint_base)}/secure/chat`;
  }

  /** Asked when the page opens, and by the nav before it offers a Chat link at all. */
  status(): Observable<ChatStatus> {
    return this._httpClient.get<ResponseWrapper>(`${this.base()}/status`).pipe(map((r) => r.data as ChatStatus));
  }

  ask(message: string, conversationId?: string): Observable<ChatAnswer> {
    return this._httpClient
      .post<ResponseWrapper>(this.base(), { message, ...(conversationId ? { conversation_id: conversationId } : {}) })
      .pipe(map((r) => r.data as ChatAnswer));
  }

  conversations(): Observable<ChatConversation[]> {
    return this._httpClient.get<ResponseWrapper>(`${this.base()}/conversations`).pipe(map((r) => (r.data ?? []) as ChatConversation[]));
  }

  messages(conversationId: string): Observable<ChatMessage[]> {
    return this._httpClient
      .get<ResponseWrapper>(`${this.base()}/conversations/${encodeURIComponent(conversationId)}`)
      .pipe(map((r) => (r.data ?? []) as ChatMessage[]));
  }

  forget(conversationId: string): Observable<boolean> {
    return this._httpClient
      .delete<ResponseWrapper>(`${this.base()}/conversations/${encodeURIComponent(conversationId)}`)
      .pipe(map((r) => !!r.data));
  }
}
