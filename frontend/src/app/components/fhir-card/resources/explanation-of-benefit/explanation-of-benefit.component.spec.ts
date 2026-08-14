import {ComponentFixture, TestBed} from '@angular/core/testing';
import {RouterTestingModule} from '@angular/router/testing';

import {ExplanationOfBenefitComponent, amountLabel, money} from './explanation-of-benefit.component';
import {ExplanationOfBenefitModel} from '../../../../../lib/models/resources/explanation-of-benefit-model';
import {fhirVersions} from '../../../../../lib/models/constants';

const EOB = {
  resourceType: 'ExplanationOfBenefit',
  id: 'eob-1',
  status: 'active',
  outcome: 'complete',
  disposition: 'Claim settled as per contract.',
  created: '2026-03-14T00:00:00Z',
  type: {coding: [{code: 'professional', display: 'Professional'}]},
  patient: {reference: 'Patient/1'},
  provider: {reference: 'Organization/2', display: 'Springfield Clinic'},
  insurer: {reference: 'Organization/3', display: 'Blue Cross'},
  billablePeriod: {start: '2026-03-01', end: '2026-03-02'},
  total: [
    {category: {coding: [{code: 'submitted'}]}, amount: {value: 400, currency: 'USD'}},
    {category: {coding: [{code: 'benefit'}]}, amount: {value: 320, currency: 'USD'}},
    {category: {coding: [{code: 'copay'}]}, amount: {value: 25, currency: 'USD'}},
  ],
};

describe('ExplanationOfBenefitComponent', () => {
  let component: ExplanationOfBenefitComponent;
  let fixture: ComponentFixture<ExplanationOfBenefitComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExplanationOfBenefitComponent, RouterTestingModule],
    }).compileComponents();

    fixture = TestBed.createComponent(ExplanationOfBenefitComponent);
    component = fixture.componentInstance;
    component.displayModel = new ExplanationOfBenefitModel(EOB, fhirVersions.R4);
    fixture.detectChanges();
  });

  const text = () => (fixture.nativeElement as HTMLElement).textContent;

  it('should lead with the claim type rather than a resource name', () => {
    expect(component.heading).toEqual('Professional');
    expect(text()).toContain('Professional');
  });

  it('should show the service period', () => {
    expect(component.serviceDates).toEqual('2026-03-01 to 2026-03-02');
  });

  // The whole point of the resource: what was billed, what insurance paid, what is left.
  it('should show the money in plain language', () => {
    const labels = component.amounts.map((a) => a.label);

    expect(labels).toContain('Amount billed');
    expect(labels).toContain('Paid by insurance');
    expect(labels).toContain('Your copay');
    expect(text()).toContain('$400.00');
    expect(text()).toContain('$25.00');
  });

  it('should prefer the payer sentence over the outcome code', () => {
    const result = component.tableData.find((row) => row.label === 'Result');
    expect(result.data).toEqual('Claim settled as per contract.');
  });
});

describe('amountLabel', () => {
  it('should translate C4BB adjudication codes', () => {
    expect(amountLabel({coding: [{code: 'submitted'}]})).toEqual('Amount billed');
    expect(amountLabel({coding: [{code: 'deductible'}]})).toEqual('Applied to your deductible');
    expect(amountLabel({coding: [{code: 'PATIENTPAY'}]})).toEqual('Your responsibility');
  });

  // An unrecognised category is still a real number on a real statement; fall back to what the
  // payer called it rather than dropping the row or inventing a label (#262).
  it('should fall back to the payer text for an unknown code', () => {
    expect(amountLabel({coding: [{code: 'somethingelse'}], text: 'Vision allowance'}))
      .toEqual('Vision allowance');
  });
});

describe('money', () => {
  it('should format using the currency on the resource', () => {
    expect(money({value: 1234.5, currency: 'USD'})).toContain('1,234.50');
  });

  it('should not lose the number on an unknown currency', () => {
    expect(money({value: 10, currency: 'XYZ'})).toContain('10');
  });

  it('should render nothing when there is no amount', () => {
    expect(money(undefined)).toEqual('');
    expect(money({value: null})).toEqual('');
  });
});
