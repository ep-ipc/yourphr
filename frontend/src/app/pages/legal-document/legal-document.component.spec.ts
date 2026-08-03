import {ComponentFixture, TestBed, waitForAsync} from '@angular/core/testing';
import {ActivatedRoute} from '@angular/router';
import {RouterTestingModule} from '@angular/router/testing';
import {of, throwError} from 'rxjs';

import {LegalDocumentComponent} from './legal-document.component';
import {FastenApiService} from '../../services/fasten-api.service';
import {LegalDocument} from '../../models/fasten/legal-document';

describe('LegalDocumentComponent', () => {
  let component: LegalDocumentComponent;
  let fixture: ComponentFixture<LegalDocumentComponent>;
  let apiSpy: jasmine.SpyObj<FastenApiService>;

  const doc = (over: Partial<LegalDocument> = {}): LegalDocument => ({
    kind: 'privacy',
    html: '<h1>Privacy Policy</h1><p>We hold your records.</p>',
    digest: 'sha256:abc123',
    source: 'shipped',
    ...over,
  });

  const setup = (kind = 'privacy') => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [LegalDocumentComponent, RouterTestingModule],
      providers: [
        {provide: FastenApiService, useValue: apiSpy},
        {provide: ActivatedRoute, useValue: {data: of({kind})}},
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LegalDocumentComponent);
    component = fixture.componentInstance;
  };

  beforeEach(waitForAsync(() => {
    apiSpy = jasmine.createSpyObj('FastenApiService', ['getLegalDocument']);
    apiSpy.getLegalDocument.and.returnValue(of(doc()));
  }));

  it('renders the document served by this instance', () => {
    setup('privacy');
    fixture.detectChanges();

    expect(apiSpy.getLegalDocument).toHaveBeenCalledWith('privacy');
    expect(fixture.nativeElement.textContent).toContain('We hold your records.');
  });

  it('asks for the terms when routed to /terms', () => {
    setup('terms');
    apiSpy.getLegalDocument.and.returnValue(of(doc({kind: 'terms', html: '<p>Terms body</p>'})));
    fixture.detectChanges();

    expect(apiSpy.getLegalDocument).toHaveBeenCalledWith('terms');
    expect(component.title).toBe('Terms of Service');
  });

  // "Whose policy is this" is a fair question — the operator is the data controller, so a
  // document they wrote should not be indistinguishable from the shipped one.
  it('says when the operator published their own text', () => {
    setup('privacy');
    apiSpy.getLegalDocument.and.returnValue(of(doc({source: 'operator'})));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Published by the operator of this instance');
  });

  it('says when the shipped document is in use', () => {
    setup('privacy');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('has not published their own');
  });

  // The digest is what a consent record pins, so it has to be visible to a reader too.
  it('shows the document version', () => {
    setup('privacy');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('sha256:abc123');
  });

  // Angular sanitizes [innerHTML]; an operator's Markdown renders but script does not survive.
  it('strips script from operator-supplied markup', () => {
    setup('privacy');
    apiSpy.getLegalDocument.and.returnValue(of(doc({
      source: 'operator',
      html: '<p>Real text</p><script>window.pwned = true;</script>',
    })));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Real text');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
  });

  // A broken operator override must be reported, not papered over — otherwise the reader sees a
  // document their operator deliberately replaced.
  it('reports a failure instead of showing nothing', () => {
    setup('privacy');
    apiSpy.getLegalDocument.and.returnValue(
      throwError(() => ({error: {error: 'legal override is empty'}})));
    fixture.detectChanges();

    expect(component.loading).toBeFalse();
    expect(component.error).toBe('legal override is empty');
    expect(fixture.nativeElement.textContent).toContain('legal override is empty');
  });
});
