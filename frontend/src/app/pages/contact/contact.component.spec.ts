import {ComponentFixture, TestBed, waitForAsync} from '@angular/core/testing';
import {RouterTestingModule} from '@angular/router/testing';
import {of, throwError} from 'rxjs';

import {ContactComponent} from './contact.component';
import {FastenApiService} from '../../services/fasten-api.service';

describe('ContactComponent', () => {
  let component: ContactComponent;
  let fixture: ComponentFixture<ContactComponent>;
  let apiSpy: jasmine.SpyObj<FastenApiService>;

  const info = (over: Partial<{name: string; contact_email: string; contact_url: string}> = {}) =>
    of({name: '', contact_email: '', contact_url: '', theme: '', ...over});

  beforeEach(waitForAsync(() => {
    apiSpy = jasmine.createSpyObj('FastenApiService', ['getPublicInstanceInfo']);
    apiSpy.getPublicInstanceInfo.and.returnValue(info());
    TestBed.configureTestingModule({
      imports: [ContactComponent, RouterTestingModule],
      providers: [{provide: FastenApiService, useValue: apiSpy}],
    }).compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ContactComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('renders every operator field the Instance card provides', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(info({
      name: 'Nerds by the Hour',
      contact_email: 'admin@yourphr.org',
      contact_url: 'https://example.org/help',
    }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Nerds by the Hour');
    expect(text).toContain('admin@yourphr.org');
    expect(fixture.nativeElement.querySelector('a[href="mailto:admin@yourphr.org"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('a[href="https://example.org/help"]')).not.toBeNull();
  });

  it('shows only the fields that are set', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(info({contact_email: 'admin@yourphr.org'}));
    fixture.detectChanges();

    expect(component.hasOperatorContact).toBeTrue();
    expect(fixture.nativeElement.textContent).not.toContain('Operated by');
    expect(fixture.nativeElement.querySelector('a[href="mailto:admin@yourphr.org"]')).not.toBeNull();
  });

  // Says so plainly rather than substituting a project address — the maintainers are a different
  // party from the operator and cannot act on anyone's records.
  it('states plainly when the operator published nothing', () => {
    fixture.detectChanges();

    expect(component.hasOperatorContact).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('has not published contact details');
  });

  // Guards against a flash of "not configured" while the request is still in flight.
  it('does not claim "not published" before the response arrives', () => {
    expect(component.loaded).toBeFalse();
  });

  it('still shows project contacts when the endpoint fails', () => {
    apiSpy.getPublicInstanceInfo.and.returnValue(throwError(() => new Error('boom')));
    fixture.detectChanges();

    expect(component.loaded).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('github.com/jwilleke/yourphr/issues');
  });

  // The operator holds the records; the project does not. Conflating them would send a patient
  // to people who cannot help and should not see their data.
  it('separates instance contacts from project contacts', () => {
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('This instance');
    expect(text).toContain('The YourPHR project');
    expect(text).toContain('no access to your records');
  });
});
