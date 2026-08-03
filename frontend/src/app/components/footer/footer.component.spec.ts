import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { FooterComponent } from './footer.component';
import { FastenApiService } from '../../services/fasten-api.service';

describe('FooterComponent', () => {
  let component: FooterComponent;
  let fixture: ComponentFixture<FooterComponent>;

  let apiSpy: jasmine.SpyObj<FastenApiService>;

  beforeEach(waitForAsync(() => {
    apiSpy = jasmine.createSpyObj('FastenApiService', ['getVersion', 'getPublicInstanceInfo']);
    apiSpy.getVersion.and.returnValue(of({ version: '1.9.0', environment_name: '' }));
    apiSpy.getPublicInstanceInfo.and.returnValue(of({ name: '', contact_email: '', contact_url: '', theme: '' }));
    TestBed.configureTestingModule({
      declarations: [ FooterComponent ],
      providers: [ { provide: FastenApiService, useValue: apiSpy } ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(FooterComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('uses runtime environment_name from /api/version when set', () => {
    apiSpy.getVersion.and.returnValue(of({ version: '1.18.2', environment_name: 'demo' }));
    component.ngOnInit();
    expect(component.appVersion).toBe('demo-1.18.2');
  });

  it('falls back to build-time environment_name when API omits it', () => {
    apiSpy.getVersion.and.returnValue(of({ version: '1.18.2', environment_name: '' }));
    component.ngOnInit();
    // TestBed uses the default environment.ts (sandbox) unless fileReplacements apply.
    expect(component.appVersion).toMatch(/^.+-1\.18\.2$/);
    expect(component.appVersion.endsWith('-1.18.2')).toBeTrue();
    expect(component.appVersion.startsWith('demo-')).toBeFalse();
  });

  it('links to the Contact Us page', () => {
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('a[routerLink="/contact"]');
    expect(link).not.toBeNull();
    expect(link.textContent.trim()).toBe('Contact Us');
  });

  // The footer no longer renders operator details inline (#454) — they live on /contact, which is
  // three fields and needs room. A regression here would put an address back in the chrome.
  it('does not render operator contact details inline', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Operated by');
    expect(fixture.nativeElement.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});
