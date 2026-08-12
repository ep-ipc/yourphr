import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { of, throwError } from 'rxjs';
import { PipesModule } from '../../pipes/pipes.module';
import { FastenApiService } from '../../services/fasten-api.service';
import { UserListComponent } from './user-list.component';
import { AdminBackLinkComponent } from '../../components/admin-back-link/admin-back-link.component';

const USERS = [
  {id: '1', username: 'jim', full_name: 'Jim Willeke', email: 'jim@example.org', role: 'admin', last_login: '2026-08-12T10:00:00Z', login_count: 47},
  {id: '2', username: 'kid', full_name: 'A Child', email: 'kid@example.org', role: 'user', login_count: 0},
  {id: '3', username: 'gran', full_name: 'Grandparent', email: 'gran@elsewhere.org', role: 'user', login_count: 3},
];

describe('UserListComponent', () => {
  let component: UserListComponent;
  let fixture: ComponentFixture<UserListComponent>;
  let api: jasmine.SpyObj<FastenApiService>;
  let modal: jasmine.SpyObj<NgbModal>;

  beforeEach(async () => {
    api = jasmine.createSpyObj('FastenApiService', ['getAllUsers', 'adminResetUserPassword']);
    api.getAllUsers.and.returnValue(of(USERS as any));
    api.adminResetUserPassword.and.returnValue(of({username: 'kid', password: 'a-generated-value'}));
    modal = jasmine.createSpyObj('NgbModal', ['open']);
    modal.open.and.returnValue({result: Promise.resolve()} as any);

    await TestBed.configureTestingModule({
      declarations: [UserListComponent],
      imports: [PipesModule, FormsModule, RouterTestingModule, AdminBackLinkComponent],
      providers: [
        {provide: FastenApiService, useValue: api},
        {provide: NgbModal, useValue: modal},
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(UserListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create and load users', () => {
    expect(component).toBeTruthy();
    expect(component.users.length).toBe(3);
    expect(component.filteredUsers.length).toBe(3);
  });

  it('counts admins for the summary card', () => {
    expect(component.adminCount).toBe(1);
  });

  // Search covers the three things an admin actually knows about the person they are looking for.
  it('searches by name, username and email', () => {
    component.search = 'willeke';
    component.applyFilters();
    expect(component.filteredUsers.map(u => u.username)).toEqual(['jim']);

    component.search = 'gran';
    component.applyFilters();
    expect(component.filteredUsers.map(u => u.username)).toEqual(['gran']);

    component.search = 'elsewhere.org';
    component.applyFilters();
    expect(component.filteredUsers.map(u => u.username)).toEqual(['gran']);
  });

  it('matches case-insensitively', () => {
    component.search = 'JIM';
    component.applyFilters();
    expect(component.filteredUsers.length).toBe(1);
  });

  it('filters to admins from the summary card, and toggles back off', () => {
    component.setQuickFilter('admin');
    expect(component.filteredUsers.map(u => u.username)).toEqual(['jim']);

    // Clicking the active card clears it, so the cards behave like toggles rather than a one-way
    // trip that needs the Clear button to escape.
    component.setQuickFilter('admin');
    expect(component.filteredUsers.length).toBe(3);
  });

  it('combines the search box with the quick filter', () => {
    component.setQuickFilter('admin');
    component.search = 'kid';
    component.applyFilters();
    expect(component.filteredUsers.length).toBe(0);
  });

  it('clears both filters', () => {
    component.setQuickFilter('admin');
    component.search = 'jim';
    component.applyFilters();

    component.clearFilters();

    expect(component.search).toBe('');
    expect(component.quickFilter).toBe('total');
    expect(component.filteredUsers.length).toBe(3);
  });

  // The empty state exists because a table with headers and no rows reads as broken rather than as
  // "nothing matched".
  it('renders the empty state when nothing matches', () => {
    component.search = 'nobody-by-that-name';
    component.applyFilters();
    fixture.detectChanges();

    expect(component.filteredUsers.length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No users match the current filters');
  });

  // #486: the Bootstrap 4 names render white-on-white in light mode, and there is a build guard —
  // this pins the rendered output as well, since the guard only greps source.
  it('renders roles with Bootstrap 5 badge classes', () => {
    const badges = (fixture.nativeElement as HTMLElement).querySelectorAll('.badge');
    expect(badges.length).toBe(3);
    expect(badges[0].className).toContain('text-bg-danger');
    expect(badges[1].className).toContain('text-bg-secondary');
    expect(badges[0].className).not.toContain('badge-');
  });

  // #512: an account nobody has ever used is a fact worth stating, not a blank cell.
  it('shows Never for an account that has never signed in', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('Never');
  });

  it('resets a password and reports it once', async () => {
    // A dialog that never resolves, i.e. one still on screen. The default mock resolves
    // immediately, which is the CLOSED case — and closing is what clears the value.
    modal.open.and.returnValue({result: new Promise(() => {})} as any);

    component.resetPassword(USERS[1] as any, {} as any);
    await Promise.resolve();

    expect(api.adminResetUserPassword).toHaveBeenCalledWith('2');
    expect(modal.open).toHaveBeenCalled();
    expect(component.resetResult?.password).toBe('a-generated-value');
    expect(component.notice).toContain('kid');
  });

  // The generated password must not outlive the dialog: whatever the admin does next should not
  // have another person's credential sitting behind it in component state.
  it('drops the password from memory once the dialog closes', async () => {
    component.resetPassword(USERS[1] as any, {} as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(component.resetResult).toBeNull();
  });

  it('reports a failed reset rather than pretending it worked', () => {
    api.adminResetUserPassword.and.returnValue(throwError(() => ({error: {error: 'Unauthorized'}})));

    component.resetPassword(USERS[1] as any, {} as any);

    expect(component.errorMsg).toBe('Unauthorized');
    expect(component.resetResult).toBeNull();
    expect(modal.open).not.toHaveBeenCalled();
  });
});
