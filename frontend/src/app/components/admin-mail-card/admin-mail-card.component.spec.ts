import {ComponentFixture, TestBed, waitForAsync} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {RouterTestingModule} from '@angular/router/testing';
import {AdminMailCardComponent} from './admin-mail-card.component';
import {FastenApiService} from '../../services/fasten-api.service';
import {MailStatus} from '../../models/fasten/mail-status';

describe('AdminMailCardComponent', () => {
  let fixture: ComponentFixture<AdminMailCardComponent>;
  let component: AdminMailCardComponent;
  let apiSpy: jasmine.SpyObj<FastenApiService>;

  const smtp = (over: Partial<MailStatus> = {}): MailStatus => ({
    enabled: false,
    provider: 'smtp',
    from: 'phr@example.org',
    smtp: {host: 'relay.example.org', port: 587, secure: false, user: 'phr', passwordSet: true},
    destination: 'relay.example.org:587 (STARTTLS required)',
    problems: [],
    ...over,
  });

  beforeEach(waitForAsync(() => {
    apiSpy = jasmine.createSpyObj('FastenApiService', ['getMailStatus', 'sendTestMail']);
    apiSpy.getMailStatus.and.returnValue(of(smtp()));
    TestBed.configureTestingModule({
      imports: [AdminMailCardComponent, RouterTestingModule],
      providers: [{provide: FastenApiService, useValue: apiSpy}],
    }).compileComponents();
  }));

  const render = async () => {
    fixture = TestBed.createComponent(AdminMailCardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  };

  // Types the address and presses the button the way a person does, so ngModel and the template
  // agree on when it changed (settings.component.spec.ts has the longer note on why).
  const sendTo = async (address: string) => {
    const input = fixture.nativeElement.querySelector('#mailTestTo') as HTMLInputElement;
    input.value = address;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const text = () => (fixture.nativeElement as HTMLElement).textContent || '';

  it('says mail is off and where it would go', async () => {
    await render();
    expect(text()).toContain('Off');
    expect(text()).toContain('relay.example.org:587 (STARTTLS required)');
    expect(text()).toContain('phr@example.org');
  });

  it('lists what stops mail from being sent', async () => {
    apiSpy.getMailStatus.and.returnValue(of(smtp({problems: ['No SMTP relay: set yourphr.mail.provider.smtp.host.']})));
    await render();
    const problems = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="mail-problems"]');
    expect(problems?.textContent).toContain('smtp.host');
  });

  it('reports a delivered test message', async () => {
    await render();
    apiSpy.sendTestMail.and.returnValue(of({sent: true, provider: 'smtp', destination: 'relay.example.org:587 (STARTTLS required)'}));
    await sendTo('root@example.org');
    expect(apiSpy.sendTestMail).toHaveBeenCalledWith('root@example.org');
    expect(text()).toContain('Sent to root@example.org');
  });

  it('says a console-provider test went to the log, not to an inbox', async () => {
    await render();
    apiSpy.sendTestMail.and.returnValue(of({sent: true, provider: 'console', destination: 'the server log'}));
    await sendTo('root@example.org');
    expect(text()).toContain('Written to the server log');
  });

  it("shows the server's sentence when a test fails", async () => {
    await render();
    apiSpy.sendTestMail.and.returnValue(throwError(() => new HttpErrorResponse({status: 502, error: {success: false, error: 'The relay at relay.example.org:587 refused the username or password'}})));
    await sendTo('root@example.org');
    const err = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="mail-test-error"]');
    expect(err?.textContent).toContain('refused the username or password');
    expect(component.sending).toBeFalse();
  });

  it('shows nothing to a read-only admin, who may not read mail settings', async () => {
    apiSpy.getMailStatus.and.returnValue(throwError(() => new HttpErrorResponse({status: 403, error: {success: false, error: 'forbidden'}})));
    await render();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="admin-mail-card"]')).toBeNull();
  });
});
