import {ComponentFixture, TestBed} from '@angular/core/testing';
import {RouterTestingModule} from '@angular/router/testing';
import {of, throwError} from 'rxjs';

import {PatientEntryComponent} from './patient-entry.component';
import {FastenApiService} from '../../services/fasten-api.service';

describe('PatientEntryComponent', () => {
  let component: PatientEntryComponent;
  let fixture: ComponentFixture<PatientEntryComponent>;
  let api: jasmine.SpyObj<FastenApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj('FastenApiService', ['createPatientEntry']);
    api.createPatientEntry.and.returnValue(of({
      resource_type: 'Observation',
      source_resource_id: 'obs-1',
      source_id: 'src-1',
      sort_title: 'Body weight 70 kg',
    }));

    await TestBed.configureTestingModule({
      imports: [PatientEntryComponent, RouterTestingModule],
      providers: [{provide: FastenApiService, useValue: api}],
    }).compileComponents();

    fixture = TestBed.createComponent(PatientEntryComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates and submits a weight vital', () => {
    component.vital = 'body_weight';
    component.value = 70;
    component.submit();
    expect(api.createPatientEntry).toHaveBeenCalled();
    const arg = api.createPatientEntry.calls.mostRecent().args[0];
    expect(arg.vital).toBe('body_weight');
    expect(arg.value).toBe(70);
    expect(component.successMsg).toContain('Body weight');
  });

  it('requires systolic and diastolic for blood pressure', () => {
    component.vital = 'blood_pressure';
    component.systolic = null;
    component.diastolic = null;
    component.submit();
    expect(api.createPatientEntry).not.toHaveBeenCalled();
    expect(component.error).toContain('systolic');
  });

  it('surfaces API errors', () => {
    api.createPatientEntry.and.returnValue(throwError(() => ({error: {error: 'boom'}})));
    component.vital = 'heart_rate';
    component.value = 60;
    component.submit();
    expect(component.error).toBeTruthy();
  });
});
