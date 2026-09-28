import {Component, OnInit, ChangeDetectionStrategy, Input} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {FastenApiService} from '../../services/fasten-api.service';
import {MailStatus} from '../../models/fasten/mail-status';

// Email card on Admin -> Configuration (yourphr#536). Says whether this instance sends mail, where
// it would go, what stops it — and sends a test message, so an operator can prove a relay before
// turning mail on rather than learning it was wrong from an alert that never arrived (#789).
// The settings themselves are ordinary configuration rows (yourphr.mail.*) on the same page.
@Component({
  standalone: true,
  imports: [FormsModule],
  selector: 'app-admin-mail-card',
  templateUrl: './admin-mail-card.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class AdminMailCardComponent implements OnInit {
  // Bumped by the page after a configuration change, so the card re-reads the settings.
  @Input() set refresh(_: number) { if (this.loaded) this.load(); }

  status: MailStatus | null = null;
  loaded = false;
  error = '';

  to = '';
  sending = false;
  result = '';
  sendError = '';

  constructor(private fastenApi: FastenApiService) {}

  ngOnInit() {
    this.load();
  }

  load() {
    this.error = '';
    this.fastenApi.getMailStatus().subscribe({
      next: (status) => { this.status = status; this.loaded = true; },
      error: (err: HttpErrorResponse) => { this.error = err?.error?.error || 'Could not read the mail settings.'; this.loaded = true; },
    });
  }

  sendTest() {
    const to = this.to.trim();
    if (!to) return;
    this.sending = true;
    this.result = '';
    this.sendError = '';
    this.fastenApi.sendTestMail(to).subscribe({
      next: (r) => {
        this.sending = false;
        this.result = r.provider === 'console'
          ? `Written to the server log (the console provider), not emailed. Choose the smtp provider to send real mail.`
          : `Sent to ${to} through ${r.destination}. Check that inbox — including spam.`;
      },
      error: (err: HttpErrorResponse) => {
        this.sending = false;
        this.sendError = err?.error?.error || 'The test message could not be sent.';
      },
    });
  }
}
