import {Component, OnInit, TemplateRef} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {FastenApiService} from '../../services/fasten-api.service';
import {AccountUser} from '../../models/fasten/account-user';
import {LegalConsentStatus} from '../../models/fasten/legal-consent';

// Account Profile — the system *user account* (login/identity/lifecycle), distinct from the medical
// "Patient Profile" (the FHIR Patient record). Includes PP/ToS consent grant/revoke (#427).
@Component({
  selector: 'app-account-profile',
  templateUrl: './account-profile.component.html',
  styleUrls: ['./account-profile.component.scss'],
  standalone: false,
})
export class AccountProfileComponent implements OnInit {
  loading = {page: false, delete: false};
  user: AccountUser = {};

  // Change-password form state.
  pw = {current: '', next: '', confirm: ''};
  pwError = '';
  pwSuccess = false;
  pwSubmitting = false;

  // Legal consent (#427)
  legalConsent: LegalConsentStatus | null = null;
  legalConsentLoading = false;
  legalConsentError = '';
  legalConsentMsg = '';
  legalConsentBusy = false;
  /** Active opt-in must be unchecked by default before grant. */
  legalOptInChecked = false;

  constructor(
    private fastenApi: FastenApiService,
    private modalService: NgbModal,
  ) {}

  ngOnInit(): void {
    this.loading.page = true;
    this.fastenApi.getCurrentUser().subscribe({
      next: (u) => {
        this.user = u || {};
        this.loading.page = false;
      },
      error: () => {
        this.loading.page = false;
      },
    });
    this.loadLegalConsent();
  }

  loadLegalConsent(): void {
    this.legalConsentLoading = true;
    this.legalConsentError = '';
    this.fastenApi.getLegalConsent().subscribe({
      next: (s) => {
        this.legalConsent = s;
        this.legalOptInChecked = false;
        this.legalConsentLoading = false;
      },
      error: () => {
        this.legalConsentError = 'Could not load privacy consent status.';
        this.legalConsentLoading = false;
      },
    });
  }

  grantLegalConsent(): void {
    this.legalConsentError = '';
    this.legalConsentMsg = '';
    if (!this.legalOptInChecked) {
      this.legalConsentError = 'Check the box to confirm you have read and agree before continuing.';
      return;
    }
    this.legalConsentBusy = true;
    this.fastenApi.grantLegalConsent().subscribe({
      next: (s) => {
        this.legalConsent = s;
        this.legalOptInChecked = false;
        this.legalConsentMsg = 'Consent saved. You can connect medical sources when a provider is available.';
        this.legalConsentBusy = false;
      },
      error: (err) => {
        this.legalConsentError = err?.error?.error || 'Could not save consent.';
        this.legalConsentBusy = false;
      },
    });
  }

  revokeLegalConsent(): void {
    this.legalConsentError = '';
    this.legalConsentMsg = '';
    this.legalConsentBusy = true;
    this.fastenApi.revokeLegalConsent().subscribe({
      next: (s) => {
        this.legalConsent = {
          accepted: false,
          accepted_at: '',
          privacy_policy_url: s.privacy_policy_url || this.legalConsent?.privacy_policy_url || 'https://yourphr.org/privacy.html',
          terms_of_service_url: s.terms_of_service_url || this.legalConsent?.terms_of_service_url || 'https://yourphr.org/terms.html',
        };
        const n = s.medicare_sources_disconnected ?? 0;
        this.legalConsentMsg = n > 0
          ? `Consent revoked. Disconnected ${n} Medicare source(s) (tokens cleared; imported records kept). New Medicare connections are blocked until you agree again.`
          : 'Consent revoked. New Medicare connections are blocked until you agree again.';
        this.legalOptInChecked = false;
        this.legalConsentBusy = false;
      },
      error: (err) => {
        this.legalConsentError = err?.error?.error || 'Could not revoke consent.';
        this.legalConsentBusy = false;
      },
    });
  }

  // Initials avatar fallback (no uploaded photo yet — Phase 3).
  get initials(): string {
    const src = (this.user.full_name || this.user.username || '').trim();
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  changePassword(): void {
    this.pwError = '';
    this.pwSuccess = false;
    if (!this.pw.current || !this.pw.next) {
      this.pwError = 'Please fill in all fields.';
      return;
    }
    if (this.pw.next !== this.pw.confirm) {
      this.pwError = 'The new passwords do not match.';
      return;
    }
    this.pwSubmitting = true;
    this.fastenApi.changePassword(this.pw.current, this.pw.next).subscribe({
      next: () => {
        this.pwSubmitting = false;
        this.pwSuccess = true;
        this.pw = {current: '', next: '', confirm: ''};
      },
      error: (err) => {
        this.pwSubmitting = false;
        this.pwError = err?.error?.error || 'Could not change your password. Please try again.';
      },
    });
  }

  openDeleteModal(content: TemplateRef<any>): void {
    this.modalService.open(content, {ariaLabelledBy: 'delete-account-title'});
  }

  deleteAccount(): void {
    this.loading.delete = true;
    this.fastenApi.deleteAccount().subscribe({
      next: () => {
        this.loading.delete = false;
      },
      error: () => {
        this.loading.delete = false;
      },
    });
  }
}
