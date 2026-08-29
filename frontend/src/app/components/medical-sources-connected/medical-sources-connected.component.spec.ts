import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';

import { MedicalSourcesConnectedComponent } from './medical-sources-connected.component';
import {HTTP_CLIENT_TOKEN} from '../../dependency-injection';
import { HttpClient, provideHttpClient, withInterceptorsFromDi, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import {RouterTestingModule} from '@angular/router/testing';
import { LoadingSpinnerComponent } from '../loading-spinner/loading-spinner.component';
import { FastenApiService } from '../../services/fasten-api.service';
import { EventBusService } from '../../services/event-bus.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { EventSourceComplete } from '../../models/events/event_source_complete';
import { EventSourceSync } from '../../models/events/event_source_sync';

describe('MedicalSourcesConnectedComponent', () => {
  let component: MedicalSourcesConnectedComponent;
  let fixture: ComponentFixture<MedicalSourcesConnectedComponent>;
  let fastenApi: jasmine.SpyObj<FastenApiService>;
  let sourceComplete$: Subject<EventSourceComplete>;
  let sourceSync$: Subject<EventSourceSync>;

  beforeEach(async () => {
    sourceComplete$ = new Subject<EventSourceComplete>();
    sourceSync$ = new Subject<EventSourceSync>();
    fastenApi = jasmine.createSpyObj('FastenApiService', ['getSources', 'syncSource', 'deleteSource', 'exportSource']);
    fastenApi.getSources.and.returnValue(of([]));

    const eventBus = {
      SourceSyncMessages: sourceSync$,
      SourceCompleteMessages: sourceComplete$,
    };

    await TestBed.configureTestingModule({
    declarations: [MedicalSourcesConnectedComponent],
    imports: [RouterTestingModule, LoadingSpinnerComponent],
    providers: [
        {
            provide: HTTP_CLIENT_TOKEN,
            useClass: HttpClient,
        },
        provideHttpClient(withXhr(), withInterceptorsFromDi()),
        provideHttpClientTesting(),
        { provide: FastenApiService, useValue: fastenApi },
        { provide: EventBusService, useValue: eventBus },
        { provide: AuthService, useValue: { IsAuthenticatedSubject: of(true) } },
        { provide: ToastService, useValue: jasmine.createSpyObj('ToastService', ['show']) },
    ]
})
    .compileComponents();

    fixture = TestBed.createComponent(MedicalSourcesConnectedComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('clears progress spinner on source_complete SSE (#337)', () => {
    component.status['src-1'] = 'token';
    component.connectedSourceList = [{ source: { id: 'src-1', brand_id: 'brand-1' } as any, brand: { id: 'brand-1' } as any }];
    component.status['brand-1'] = 'token';

    sourceComplete$.next({ event_type: 'source_complete', source_id: 'src-1' } as EventSourceComplete);

    expect(component.status['src-1']).toBeUndefined();
    expect(component.status['brand-1']).toBeUndefined();
  });

  it('reconciles DONE job via poll when SSE is missing (#337)', () => {
    component.status['src-2'] = 'token';
    component.connectedSourceList = [{ source: { id: 'src-2', brand_id: 'b2' } as any, brand: null as any }];
    fastenApi.getSources.and.returnValue(of([{
      id: 'src-2',
      brand_id: 'b2',
      latest_background_job: { job_status: 'STATUS_DONE' },
    } as any]));

    (component as any).reconcileJobStatus();

    expect(component.status['src-2']).toBeUndefined();
  });

});
