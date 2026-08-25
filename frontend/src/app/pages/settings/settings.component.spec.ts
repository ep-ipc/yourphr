import {ComponentFixture, TestBed} from '@angular/core/testing';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {NgbModal, NgbModule} from '@ng-bootstrap/ng-bootstrap';
import {of, throwError} from 'rxjs';

import {SettingsComponent} from './settings.component';
import {FastenApiService} from '../../services/fasten-api.service';
import {AccessToken} from '../../models/fasten/access-token';

describe('SettingsComponent', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;
  let api: jasmine.SpyObj<FastenApiService>;
  let modal: jasmine.SpyObj<NgbModal>;

  const user = {username: 'jim', full_name: 'Jim Willeke', email: 'jim@example.com', role: 'admin'};
  const tokens: AccessToken[] = [{
    token_id: 'tok-1',
    name: 'Phone',
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2026-12-31T00:00:00Z',
  }];

  beforeEach(async () => {
    api = jasmine.createSpyObj('FastenApiService', [
      'getCurrentUser', 'getAccessTokens', 'createAccessToken', 'deleteAccessToken', 'getServerDiscovery',
    ]);
    api.getCurrentUser.and.returnValue(of(user));
    api.getAccessTokens.and.returnValue(of(tokens));
    api.createAccessToken.and.returnValue(of('jwt-for-device'));
    api.deleteAccessToken.and.returnValue(of(true));
    api.getServerDiscovery.and.returnValue(of({server_base_urls: ['http://localhost:8080'], sync_endpoint: 'api/secure/resource/fhir'}));
    modal = jasmine.createSpyObj('NgbModal', ['open']);
    modal.open.and.returnValue({result: Promise.resolve()} as any);

    await TestBed.configureTestingModule({
      declarations: [SettingsComponent],
      imports: [CommonModule, FormsModule, NgbModule],
      providers: [
        {provide: FastenApiService, useValue: api},
        {provide: NgbModal, useValue: modal},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  });

  it('loads the current user and connected devices through the API service, not localStorage', () => {
    spyOn(localStorage, 'getItem').and.callThrough();

    fixture.detectChanges();

    expect(api.getCurrentUser).toHaveBeenCalled();
    expect(api.getAccessTokens).toHaveBeenCalled();
    expect(component.currentUser.username).toBe('jim');
    expect(component.tokens.length).toBe(1);
    expect(component.tokens[0].tokenId).toBe('tok-1');
    expect(localStorage.getItem).not.toHaveBeenCalledWith('token');
  });

  it('still lists devices when the profile request fails', () => {
    api.getCurrentUser.and.returnValue(throwError(() => ({status: 500})));

    fixture.detectChanges();

    expect(component.currentUser).toBeNull();
    expect(component.tokens.length).toBe(1);
  });

  it('creates a device token without reading a JWT from localStorage', () => {
    spyOn(localStorage, 'getItem').and.callThrough();
    fixture.detectChanges();

    component.newDeviceName = 'Tablet';
    component.newDeviceExpiration = 30;
    component.generateAccessToken();

    expect(api.createAccessToken).toHaveBeenCalledWith({name: 'Tablet', expiration: 30});
    expect(component.accessToken).toBe('jwt-for-device');
    expect(component.step).toBe('showQR');
    expect(localStorage.getItem).not.toHaveBeenCalledWith('token');
  });
});
