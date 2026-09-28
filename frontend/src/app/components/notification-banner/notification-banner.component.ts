import {Component, OnDestroy, OnInit, ChangeDetectionStrategy} from '@angular/core';
import {NavigationEnd, Router} from '@angular/router';
import {Subscription} from 'rxjs';
import {filter} from 'rxjs/operators';
import {FastenApiService} from '../../services/fasten-api.service';
import {AppNotification} from '../../models/fasten/app-notification';

/** How often, at most, a navigation re-asks the server. A banner a minute late is fine; a request per click is not. */
const REFRESH_MS = 60_000;

// The signed-in person's notifications, across the top of every page (#793) — first, the alert that
// no backup has succeeded (#789), which must reach an admin without them going to look for it.
// ngdpbase renders these in its server views; this is the Angular shell's equivalent. Dismissing one
// hides it from this person only.
@Component({
  standalone: true,
  selector: 'app-notification-banner',
  templateUrl: './notification-banner.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class NotificationBannerComponent implements OnInit, OnDestroy {
  notifications: AppNotification[] = [];
  private lastFetch = 0;
  private sub?: Subscription;

  constructor(private fastenApi: FastenApiService, private router: Router) {}

  ngOnInit() {
    this.refresh(true);
    this.sub = this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.refresh());
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  refresh(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFetch < REFRESH_MS) return;
    this.lastFetch = now;
    this.fastenApi.getNotifications().subscribe({
      next: (list) => this.notifications = list,
      // Signed out, or the server is away: show nothing rather than an error about a banner.
      error: () => this.notifications = [],
    });
  }

  alertClass(n: AppNotification): string {
    return {error: 'alert-danger', warning: 'alert-warning', success: 'alert-success'}[n.level] ?? 'alert-info';
  }

  icon(n: AppNotification): string {
    return {error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle', success: 'fa-check-circle'}[n.level] ?? 'fa-info-circle';
  }

  dismiss(n: AppNotification) {
    this.notifications = this.notifications.filter((x) => x.id !== n.id);
    this.fastenApi.dismissNotification(n.id).subscribe({error: () => this.refresh(true)});
  }
}
