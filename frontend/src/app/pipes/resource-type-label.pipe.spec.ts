import {ResourceTypeLabelPipe, resourceTypeLabel} from './resource-type-label.pipe';

describe('ResourceTypeLabelPipe', () => {
  it('should create an instance', () => {
    expect(new ResourceTypeLabelPipe()).toBeTruthy();
  });

  // The three Jim named: a patient should never meet a FHIR identifier.
  it('should never show a raw FHIR type name for the common documents', () => {
    expect(resourceTypeLabel('ExplanationOfBenefit')).toEqual('Insurance statement');
    expect(resourceTypeLabel('DiagnosticReport')).toEqual('Test report');
    expect(resourceTypeLabel('MedicationRequest')).toEqual('Prescription');
  });

  it('should distinguish a claim from a benefit statement', () => {
    expect(resourceTypeLabel('Claim')).toEqual('Insurance claim');
    expect(resourceTypeLabel('ExplanationOfBenefit')).toEqual('Insurance statement');
  });

  // Prescribed, taken, and dispensed are three different facts. Flattening them all to
  // "Medication" would tell the reader something the record does not say.
  it('should keep the medication resources distinct', () => {
    expect(resourceTypeLabel('MedicationRequest')).toEqual('Prescription');
    expect(resourceTypeLabel('MedicationStatement')).toEqual('Medication taken');
    expect(resourceTypeLabel('MedicationDispense')).toEqual('Medication dispensed');
    expect(resourceTypeLabel('MedicationAdministration')).toEqual('Medication given');
  });

  it('should use everyday words for clinical types', () => {
    expect(resourceTypeLabel('Encounter')).toEqual('Visit');
    expect(resourceTypeLabel('Immunization')).toEqual('Vaccination');
    expect(resourceTypeLabel('AllergyIntolerance')).toEqual('Allergy');
    expect(resourceTypeLabel('Observation')).toEqual('Test result');
  });

  // An unmapped type must degrade to something readable, without inventing a meaning for it.
  it('should split an unmapped type into words rather than showing the identifier', () => {
    expect(resourceTypeLabel('SupplyDelivery')).toEqual('Supply delivery');
    expect(resourceTypeLabel('NutritionOrder')).toEqual('Nutrition order');
  });

  it('should return an empty string for a missing type', () => {
    expect(resourceTypeLabel(undefined)).toEqual('');
    expect(resourceTypeLabel(null)).toEqual('');
    expect(resourceTypeLabel('')).toEqual('');
  });

  it('should transform through the pipe the same way', () => {
    expect(new ResourceTypeLabelPipe().transform('DiagnosticReport')).toEqual('Test report');
  });
});
