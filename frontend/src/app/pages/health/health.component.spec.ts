import {ComponentFixture, TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {HealthComponent} from './health.component';
import {FastenApiService} from '../../services/fasten-api.service';
import {HealthMetricSummary} from '../../models/fasten/health-sample';

describe('HealthComponent', () => {
  let component: HealthComponent;
  let fixture: ComponentFixture<HealthComponent>;
  let mockApi: jasmine.SpyObj<FastenApiService>;

  const hr: HealthMetricSummary = {
    metric_type: 'heart_rate',
    hk_type: 'HKQuantityTypeIdentifierHeartRate',
    unit: 'count/min',
    value_num: 72,
    latest_at: '2026-08-24T12:00:00Z',
    earliest_at: '2026-08-01T00:00:00Z',
    sample_count: 40,
    source_name: 'Apple Watch',
  };
  const sys: HealthMetricSummary = {
    metric_type: 'blood_pressure_systolic',
    hk_type: 'HKQuantityTypeIdentifierBloodPressureSystolic',
    unit: 'mmHg',
    value_num: 118,
    latest_at: '2026-08-24T08:00:00Z',
    earliest_at: '2026-08-01T00:00:00Z',
    sample_count: 4,
  };
  const dia: HealthMetricSummary = {
    metric_type: 'blood_pressure_diastolic',
    hk_type: 'HKQuantityTypeIdentifierBloodPressureDiastolic',
    unit: 'mmHg',
    value_num: 76,
    latest_at: '2026-08-24T08:00:00Z',
    earliest_at: '2026-08-01T00:00:00Z',
    sample_count: 4,
  };

  beforeEach(async () => {
    localStorage.removeItem('yourphr.health.weightUnit');
    mockApi = jasmine.createSpyObj('FastenApiService', ['getHealthMetrics', 'getHealthSeries', 'listHealthSamples']);
    mockApi.getHealthMetrics.and.returnValue(of({
      last_synced_at: '2026-08-24T12:10:00Z',
      metrics: [hr, sys, dia],
    }));
    mockApi.getHealthSeries.and.returnValue(of({
      metric_type: 'heart_rate',
      unit: 'count/min',
      total: 2,
      downsampled: false,
      points: [
        {t: '2026-08-24T10:00:00Z', v: 70},
        {t: '2026-08-24T11:00:00Z', v: 80},
      ],
      stats: {min: 70, max: 80, avg: 75},
    }));
    mockApi.listHealthSamples.and.returnValue(of({
      total: 1,
      count: 1,
      offset: 0,
      samples: [{
        id: '1',
        external_uuid: 'hr-1',
        hk_type: 'HKQuantityTypeIdentifierHeartRate',
        metric_type: 'heart_rate',
        start_time: '2026-08-24T11:00:00Z',
        end_time: '2026-08-24T11:00:00Z',
        value_num: 80,
        unit: 'count/min',
        source_name: 'Apple Watch',
      }],
    }));

    await TestBed.configureTestingModule({
      imports: [HealthComponent],
      providers: [{provide: FastenApiService, useValue: mockApi}],
    }).compileComponents();

    fixture = TestBed.createComponent(HealthComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('lists grouped metrics and defaults to a 5-day chart of the first metric', () => {
    expect(component.entries.map((e) => e.id)).toEqual(['heart_rate', 'blood_pressure']);
    expect(component.selectedId).toBe('heart_rate');
    expect(component.range).toBe('5d');
    expect(component.view).toBe('chart');
    expect(component.hasChartData).toBeTrue();
    expect(mockApi.getHealthSeries).toHaveBeenCalled();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Heart Rate');
    expect(el.textContent).toContain('Blood Pressure');
    expect(el.textContent).toContain('118/76 mmHg');
  });

  it('leaves Prepare visit summary disabled', () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector('button[disabled]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('Prepare visit summary');
  });

  it('loads the table for the same window on request', () => {
    component.setView('table');
    fixture.detectChanges();
    expect(mockApi.listHealthSamples).toHaveBeenCalled();
    expect(component.tableRows.length).toBe(1);
    expect(component.tableRows[0].value).toBe('80');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Apple Watch');
  });

  it('shows an empty state when nothing has been synced', async () => {
    mockApi.getHealthMetrics.and.returnValue(of({metrics: []}));
    fixture = TestBed.createComponent(HealthComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.entries.length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No Apple Health data yet');
  });

  it('shows an error when the catalog cannot be loaded', () => {
    mockApi.getHealthMetrics.and.returnValue(throwError(() => new Error('boom')));
    fixture = TestBed.createComponent(HealthComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.errored).toBeTrue();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Could not load your Apple Health data');
  });

  it('converts weight between kg, lbs, and stone without refetching', () => {
    const mass: HealthMetricSummary = {
      metric_type: 'body_mass',
      hk_type: 'HKQuantityTypeIdentifierBodyMass',
      unit: 'kg',
      value_num: 81.2,
      latest_at: '2026-08-24T12:00:00Z',
      earliest_at: '2026-08-01T00:00:00Z',
      sample_count: 3,
      source_name: 'iPhone',
    };
    mockApi.getHealthMetrics.and.returnValue(of({
      last_synced_at: '2026-08-24T12:10:00Z',
      metrics: [mass],
    }));
    mockApi.getHealthSeries.and.returnValue(of({
      metric_type: 'body_mass',
      unit: 'kg',
      total: 1,
      downsampled: false,
      points: [{t: '2026-08-24T10:00:00Z', v: 81.2}],
      stats: {min: 81.2, max: 81.2, avg: 81.2},
    }));
    mockApi.listHealthSamples.and.returnValue(of({
      total: 1,
      count: 1,
      offset: 0,
      samples: [{
        id: '1',
        external_uuid: 'wt-1',
        hk_type: 'HKQuantityTypeIdentifierBodyMass',
        metric_type: 'body_mass',
        start_time: '2026-08-24T10:00:00Z',
        end_time: '2026-08-24T10:00:00Z',
        value_num: 81.2,
        unit: 'kg',
        source_name: 'iPhone',
      }],
    }));

    fixture = TestBed.createComponent(HealthComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(component.selectedId).toBe('body_mass');
    expect(component.selected.latestLabel).toBe('81.2 kg');
    expect(el.textContent).toContain('kg');
    expect(el.textContent).toContain('lbs');
    expect(el.textContent).toContain('stone');

    const seriesCalls = mockApi.getHealthSeries.calls.count();
    component.setWeightUnit('lbs');
    fixture.detectChanges();
    expect(component.selected.latestLabel).toBe('179.0 lbs');
    expect(mockApi.getHealthSeries.calls.count()).toBe(seriesCalls);
    expect(component.chartData.datasets[0].data[0] as number).toBeCloseTo(179.0, 1);
    expect(localStorage.getItem('yourphr.health.weightUnit')).toBe('lbs');

    component.setWeightUnit('st');
    fixture.detectChanges();
    expect(component.selected.latestLabel).toBe('12 st 11 lb');
    expect(el.textContent).toContain('12 st 11 lb');

    component.setView('table');
    fixture.detectChanges();
    expect(component.tableRows[0].value).toBe('12 st 11 lb');
  });

  it('restores the stored weight unit on load', () => {
    localStorage.setItem('yourphr.health.weightUnit', 'lbs');
    const mass: HealthMetricSummary = {
      metric_type: 'body_mass',
      hk_type: 'HKQuantityTypeIdentifierBodyMass',
      unit: 'kg',
      value_num: 81.2,
      latest_at: '2026-08-24T12:00:00Z',
      earliest_at: '2026-08-01T00:00:00Z',
      sample_count: 1,
    };
    mockApi.getHealthMetrics.and.returnValue(of({metrics: [mass]}));
    mockApi.getHealthSeries.and.returnValue(of({
      metric_type: 'body_mass',
      unit: 'kg',
      total: 1,
      downsampled: false,
      points: [{t: '2026-08-24T10:00:00Z', v: 81.2}],
    }));
    fixture = TestBed.createComponent(HealthComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.weightUnit).toBe('lbs');
    expect(component.selected.latestLabel).toBe('179.0 lbs');
  });
});
