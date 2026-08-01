import { ConsentModel } from './consent-model';

describe('ConsentModel', () => {
  it('should create an instance', () => {
    expect(new ConsentModel({})).toBeTruthy();
  });

  // SMART Health IT–style Consent from demo.yourphr.org (#440)
  it('should parse R4 treatment / advance-directive consent', () => {
    const model = new ConsentModel({
      resourceType: 'Consent',
      id: '1367697',
      status: 'active',
      scope: {
        coding: [{ system: 'http://terminology.hl7.org/codesystem/consentscope', code: 'treatment', display: 'Treatment' }],
        text: 'Consent Scope',
      },
      category: [
        {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentcategorycodes', code: 'acd', display: 'Advance Directive' }],
          text: 'Advance Directive',
        },
      ],
      patient: { reference: 'Patient/39234650-0229-4aee-975b-c8ee68bab40b' },
      dateTime: '2021-12-11T13:39:48.21-06:00',
      performer: [{ reference: 'Patient/39234650-0229-4aee-975b-c8ee68bab40b' }],
      sourceAttachment: {
        contentType: 'application/pdf',
        title: 'Signed Consent Document',
        creation: '2021-12-11T13:39:48.21-06:00',
      },
      policyRule: {
        coding: [{ system: 'http://hl7.org/fhir/ValueSet/consent-policy', code: 'cric', display: 'Common Rule Informed Consent' }],
      },
      verification: [{ verified: true, verificationDate: '2021-12-11T13:39:48.21-06:00' }],
      provision: {
        type: 'permit',
        period: { start: '2021-12-17T13:37:00.000-06:00' },
      },
    });

    expect(model.title).toEqual('Signed Consent Document');
    expect(model.status).toEqual('active');
    expect(model.category_display).toEqual('Advance Directive');
    expect(model.document_title).toEqual('Signed Consent Document');
    expect(model.policy_display).toEqual('Common Rule Informed Consent');
    expect(model.provision_type).toEqual('permit');
    expect(model.date_time).toEqual('2021-12-11T13:39:48.21-06:00');
    expect(model.verified).toBeTrue();
    expect(model.patient).toEqual({ reference: 'Patient/39234650-0229-4aee-975b-c8ee68bab40b' });
  });

  it('falls back title to category when no sourceAttachment.title', () => {
    const model = new ConsentModel({
      status: 'active',
      category: [{ coding: [{ display: 'Do Not Resuscitate' }], text: 'Do Not Resuscitate' }],
    });
    expect(model.title).toEqual('Do Not Resuscitate');
  });
});
