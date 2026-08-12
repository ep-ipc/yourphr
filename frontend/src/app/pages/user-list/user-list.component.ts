import { Component, OnInit, TemplateRef } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { ActivatedRoute, Router } from '@angular/router';
import { User } from '../../models/fasten/user';
import { FastenApiService } from '../../services/fasten-api.service';

@Component({
    selector: 'app-user-list',
    templateUrl: './user-list.component.html',
    styleUrls: ['./user-list.component.scss'],
    standalone: false
})
export class UserListComponent implements OnInit {
  users: User[] = [];
  loading = false;

  // #511. The generated password is held only long enough to show it — never persisted here, and
  // never fetched again, because the server does not keep the plaintext either.
  resettingUserId: string | null = null;
  resetResult: {username: string, password: string} | null = null;
  copied = false;
  errorMsg = '';

  constructor(
    private fastenApi: FastenApiService,
    private router: Router,
    private route: ActivatedRoute,
    private modalService: NgbModal
  ) { }

  resetPassword(user: User, modal: TemplateRef<any>): void {
    this.errorMsg = '';
    this.copied = false;
    this.resettingUserId = user.id;
    this.fastenApi.adminResetUserPassword(user.id).subscribe({
      next: (result) => {
        this.resettingUserId = null;
        this.resetResult = result;
        this.modalService.open(modal, {ariaLabelledBy: 'reset-password-title'})
          // Drop the value as soon as the dialog goes away, however it was closed, so it does not
          // linger in component state behind whatever the admin does next.
          .result.finally(() => this.resetResult = null);
      },
      error: (err) => {
        this.resettingUserId = null;
        this.errorMsg = err?.error?.error || 'Could not reset that password. Please try again.';
      },
    });
  }

  copyPassword(): void {
    if (!this.resetResult?.password) { return; }
    navigator.clipboard?.writeText(this.resetResult.password).then(() => this.copied = true).catch(() => this.copied = false);
  }

  ngOnInit(): void {
    this.loadUsers();
  }

  loadUsers(): void {
    this.loading = true;
    this.fastenApi.getAllUsers().subscribe((users: User[]) => {
      this.users = users;
      this.loading = false;
    },
      error => {
        console.error('Error loading users:', error);
        this.loading = false;
      });
  }
}
