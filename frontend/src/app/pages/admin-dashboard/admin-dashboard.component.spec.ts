import {ComponentFixture, TestBed} from '@angular/core/testing';
import {RouterTestingModule} from '@angular/router/testing';
import {of, throwError} from 'rxjs';

import {AdminDashboardComponent} from './admin-dashboard.component';
import {FastenApiService} from '../../services/fasten-api.service';
import {RelayConfig} from '../../models/fasten/relay-config';

// A fully-configured relay: both URLs set explicitly, secret present.
const READY_RELAY: RelayConfig = {
  callback_url: 'https://relay.example.org/callback',
  configured: true,
  ready: true,
  public_url: {value: 'https://relay.example.org', source: 'configured', config_key: 'relay.public_url', env_var: 'YOURPHR_RELAY_PUBLIC_URL'},
  poll_url: {value: 'http://yourphr-relay.yourphr.svc:8080', source: 'configured', config_key: 'relay.url', env_var: 'YOURPHR_RELAY_URL'},
  secret: {value: '', source: 'configured', config_key: 'relay.secret', env_var: 'YOURPHR_RELAY_SECRET'},
};

// Nothing configured: everything fell back to the project default and no secret is set.
const DEFAULTED_RELAY: RelayConfig = {
  callback_url: 'https://relay.nerdsbythehour.com/callback',
  configured: false,
  ready: false,
  public_url: {value: 'https://relay.nerdsbythehour.com', source: 'default'},
  poll_url: {value: 'https://relay.nerdsbythehour.com', source: 'default'},
  secret: {value: '', source: 'unset', config_key: 'relay.secret', env_var: 'YOURPHR_RELAY_SECRET'},
};

function setup(relay: any, fail = false): ComponentFixture<AdminDashboardComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AdminDashboardComponent, RouterTestingModule],
    providers: [{
      provide: FastenApiService,
      useValue: {getRelayConfig: () => fail ? throwError(() => new Error('boom')) : of(relay)},
    }],
  });
  const fixture = TestBed.createComponent(AdminDashboardComponent);
  fixture.detectChanges();
  return fixture;
}

// Clicks the relay card header to toggle it. The card is collapsed by default, so any test that
// asserts on its CONTENT has to open it first.
function expandRelay(fixture: ComponentFixture<AdminDashboardComponent>): void {
  const header = fixture.nativeElement.querySelector('[aria-controls="relay-card-body"]');
  expect(header).withContext('relay card header should be present').not.toBeNull();
  header.click();
  fixture.detectChanges();
}

describe('AdminDashboardComponent', () => {
  it('should create', () => {
    expect(setup(READY_RELAY).componentInstance).toBeTruthy();
  });

  // Regression guard: the cards are routerLinks; without RouterModule they render as dead <a> with no
  // href (the bug Jim hit). Assert each admin card link resolves to a real href.
  it('renders working router links for every admin card', () => {
    const fixture = setup(READY_RELAY);
    const hrefs = Array.from(fixture.nativeElement.querySelectorAll('a[href]')).map((a: any) => a.getAttribute('href'));
    expect(hrefs).toContain('/sandbox');
    expect(hrefs).toContain('/admin/provider-catalog');
    expect(hrefs).toContain('/admin/logs');
  });

  // #402: the callback URL is what the operator must register with each FHIR vendor, so it has to
  // be visible verbatim.
  it('shows the effective callback URL once expanded', () => {
    const fixture = setup(READY_RELAY);
    expandRelay(fixture);
    expect(fixture.nativeElement.textContent).toContain('https://relay.example.org/callback');
  });

  // The whole point of #402: a value that silently fell back must NOT look like a configured one.
  it('flags defaulted values as not using your configuration', () => {
    const fixture = setup(DEFAULTED_RELAY);
    expandRelay(fixture);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('built-in default');
    expect(text).toContain('NOT in use');
  });

  // The status badge must be readable WITHOUT expanding — collapsing must never hide the one
  // signal that tells you something is wrong.
  it('shows the Not ready badge while still collapsed', () => {
    const fixture = setup(DEFAULTED_RELAY);
    expect(fixture.componentInstance.relayExpanded).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Not ready');
  });

  it('names the variable to set when no relay secret is configured', () => {
    const fixture = setup(DEFAULTED_RELAY);
    expandRelay(fixture);
    expect(fixture.nativeElement.textContent).toContain('YOURPHR_RELAY_SECRET');
  });

  it('collapses by default and toggles open and shut', () => {
    const fixture = setup(READY_RELAY);
    // Collapsed: the detail table is not in the DOM at all.
    expect(fixture.nativeElement.querySelector('#relay-card-body')).toBeNull();

    expandRelay(fixture);
    expect(fixture.nativeElement.querySelector('#relay-card-body')).not.toBeNull();

    expandRelay(fixture); // toggle shut again
    expect(fixture.nativeElement.querySelector('#relay-card-body')).toBeNull();
  });

  // The secret must never be rendered, even though the backend reports its presence.
  it('never renders a secret value, even when expanded', () => {
    const withSecret = {...READY_RELAY, secret: {...READY_RELAY.secret, value: 'super-secret-value'}};
    const fixture = setup(withSecret);
    expandRelay(fixture);
    expect(fixture.nativeElement.textContent).not.toContain('super-secret-value');
  });

  // A relay-config failure must not take the whole admin dashboard down with it.
  it('still renders the admin cards when the relay lookup fails', () => {
    const fixture = setup(null, true);
    expandRelay(fixture);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Could not load the relay configuration');
    const hrefs = Array.from(fixture.nativeElement.querySelectorAll('a[href]')).map((a: any) => a.getAttribute('href'));
    expect(hrefs).toContain('/admin/database');
  });
});
