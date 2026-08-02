import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

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

  it('shows nothing about the operator when none is configured', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(of({ name: '', contact_email: '', contact_url: '', theme: '' }));
    component.ngOnInit();
    fixture.detectChanges();

    expect(component.hasOperatorContact).toBeFalse();
    expect(fixture.nativeElement.textContent).not.toContain('Operated by');
  });

  it('renders the operator name and a mailto link when configured', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(of({
      name: 'Nerds by the Hour', contact_email: 'help@example.org', contact_url: '', theme: '',
    }));
    component.ngOnInit();
    fixture.detectChanges();

    expect(component.hasOperatorContact).toBeTrue();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Operated by');
    expect(text).toContain('Nerds by the Hour');
    expect(fixture.nativeElement.querySelector('a[href="mailto:help@example.org"]')).not.toBeNull();
  });

  // A contact URL alone is enough to be worth showing — an operator may prefer a help page
  // to publishing an address.
  it('renders a support link when only a contact URL is set', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(of({
      name: '', contact_email: '', contact_url: 'https://example.org/help', theme: '',
    }));
    component.ngOnInit();
    fixture.detectChanges();

    expect(component.hasOperatorContact).toBeTrue();
    expect(fixture.nativeElement.querySelector('a[href="https://example.org/help"]')).not.toBeNull();
  });

  // The footer must survive the endpoint being unavailable — it carries the version string.
  it('still renders when the instance-info call fails', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(throwError(() => new Error('boom')));
    component.ngOnInit();
    fixture.detectChanges();

    expect(component.hasOperatorContact).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Copyright');
  });
});
