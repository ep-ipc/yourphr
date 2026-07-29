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
  it('shows the effective callback URL', () => {
    const text = setup(READY_RELAY).nativeElement.textContent;
    expect(text).toContain('https://relay.example.org/callback');
  });

  // The whole point of #402: a value that silently fell back must NOT look like a configured one.
  it('flags defaulted values as not using your configuration', () => {
    const text = setup(DEFAULTED_RELAY).nativeElement.textContent;
    expect(text).toContain('built-in default');
    expect(text).toContain('NOT in use');
  });

  it('warns when no relay secret is configured', () => {
    const text = setup(DEFAULTED_RELAY).nativeElement.textContent;
    expect(text).toContain('Not ready');
    // ...and names the variable to set, rather than just reporting failure.
    expect(text).toContain('YOURPHR_RELAY_SECRET');
  });

  // The secret must never be rendered, even though the backend reports its presence.
  it('never renders a secret value', () => {
    const withSecret = {...READY_RELAY, secret: {...READY_RELAY.secret, value: 'super-secret-value'}};
    expect(setup(withSecret).nativeElement.textContent).not.toContain('super-secret-value');
  });

  // A relay-config failure must not take the whole admin dashboard down with it.
  it('still renders the admin cards when the relay lookup fails', () => {
    const fixture = setup(null, true);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Could not load the relay configuration');
    const hrefs = Array.from(fixture.nativeElement.querySelectorAll('a[href]')).map((a: any) => a.getAttribute('href'));
    expect(hrefs).toContain('/admin/database');
  });
});
