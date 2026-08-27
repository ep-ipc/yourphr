/**
 * Is chat available on this instance (yourphr#594)?
 *
 * The Go version answered this from `SettingsService`, reading `search.enabled` out of a payload
 * that also carried the search engine's API key to every browser. There is no such payload now:
 * the question is asked of the server, which answers from its own configuration and tells the
 * truth about a sidecar that is configured but unreachable — a state the old flag could not
 * express, and which showed up as a chat page that loaded and then failed on every message.
 */
import { Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ChatService } from '../services/chat.service';

@Injectable({ providedIn: 'root' })
export class ChatFeatureGuard implements CanActivate {
  constructor(private chat: ChatService, private router: Router) {}

  canActivate(): Observable<boolean | UrlTree> {
    return this.chat.status().pipe(
      map((status) => (status.available ? true : this.router.parseUrl('/dashboard'))),
      // A status call that fails is an instance that cannot answer questions either. Send the
      // person somewhere that works rather than to a page that cannot do anything.
      catchError(() => of(this.router.parseUrl('/dashboard')))
    );
  }
}
