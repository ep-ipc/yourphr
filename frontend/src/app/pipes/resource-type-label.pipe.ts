import {Pipe, PipeTransform} from '@angular/core';

/**
 * FHIR resource type names are not English, and a patient should never be shown one.
 *
 * "ExplanationOfBenefit", "DiagnosticReport" and "MedicationRequest" are the interoperability
 * standard's identifiers. They are meaningful to an integration engineer and meaningless to the
 * person whose records they describe, who calls those things a statement from their insurer, their
 * test results, and a prescription (#262).
 *
 * One mapping, used everywhere a type name reaches a screen, so the vocabulary cannot drift between
 * the list, the detail page and the timeline.
 */
const LABELS: Record<string, string> = {
  // Money and coverage — the vocabulary people find most opaque, and the documents they most often
  // mistake for bills.
  Claim: 'Insurance claim',
  ClaimResponse: 'Insurance decision',
  ExplanationOfBenefit: 'Insurance statement',
  Coverage: 'Insurance coverage',

  // Clinical
  AdverseEvent: 'Adverse event',
  AllergyIntolerance: 'Allergy',
  CarePlan: 'Care plan',
  CareTeam: 'Care team',
  Condition: 'Condition',
  DiagnosticReport: 'Test report',
  Encounter: 'Visit',
  FamilyMemberHistory: 'Family history',
  Goal: 'Goal',
  Immunization: 'Vaccination',
  Observation: 'Test result',
  Procedure: 'Procedure',
  ServiceRequest: 'Requested service',
  Specimen: 'Specimen',

  // Medication. Deliberately distinct: what was PRESCRIBED, what is being TAKEN, and what a pharmacy
  // handed over are three different facts, and flattening them all to "Medication" would tell the
  // reader something the record does not say.
  Medication: 'Medication',
  MedicationAdministration: 'Medication given',
  MedicationDispense: 'Medication dispensed',
  MedicationRequest: 'Prescription',
  MedicationStatement: 'Medication taken',

  // Documents and files
  Binary: 'File',
  Composition: 'Document',
  DocumentReference: 'Document',
  Media: 'Image or file',
  QuestionnaireResponse: 'Questionnaire answers',

  // People, places, things
  Appointment: 'Appointment',
  Consent: 'Consent',
  Device: 'Device',
  Location: 'Location',
  Organization: 'Organization',
  Patient: 'Patient',
  Practitioner: 'Practitioner',
  PractitionerRole: 'Practitioner role',
  Provenance: 'Where this came from',
  RelatedPerson: 'Related person',
};

/**
 * Split a FHIR type name into words as a last resort: "SupplyDelivery" -> "Supply delivery".
 *
 * Never invents a meaning for a type nobody has mapped — it only makes the identifier readable, so
 * an unmapped type degrades to something a person can at least parse rather than to jargon (#262).
 */
export function resourceTypeLabel(resourceType: string | undefined | null): string {
  if (!resourceType) {
    return '';
  }
  const known = LABELS[resourceType];
  if (known) {
    return known;
  }
  const spaced = resourceType.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

@Pipe({name: 'resourceTypeLabel', standalone: false})
export class ResourceTypeLabelPipe implements PipeTransform {
  transform(resourceType: string | undefined | null): string {
    return resourceTypeLabel(resourceType);
  }
}
