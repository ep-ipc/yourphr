import {FastenDisplayModel} from '../fasten/fasten-display-model';
import {CodableConceptModel} from '../datatypes/codable-concept-model';
import {ReferenceModel} from '../datatypes/reference-model';
import {fhirVersions, ResourceType} from '../constants';
import {FastenOptions} from '../fasten/fasten-options';
import * as _ from 'lodash';
import {CodingModel} from '../datatypes/coding-model';

/**
 * A Claim is the BILL a provider sent to an insurer (#521) — the request, not the answer.
 *
 * Worth keeping distinct from ExplanationOfBenefit, which is what the insurer decided. Patients
 * routinely receive both for the same episode of care and reasonably assume they owe both; the card
 * built on this model says which one it is looking at.
 *
 * Deliberately a thin, honest extraction: only fields the resource actually carries, no derived
 * "estimated responsibility" that FHIR did not state. A Claim's `total` is the amount CLAIMED, not
 * the amount owed, and presenting it as the latter would be inventing a number (#262).
 */
export class ClaimModel extends FastenDisplayModel {
  status: string | undefined;
  use: string | undefined;
  created: string | undefined;

  type: CodingModel[] | undefined;
  hasType: boolean | undefined;
  subType: CodableConceptModel | undefined;

  patient: ReferenceModel | undefined;
  provider: ReferenceModel | undefined;
  insurer: ReferenceModel | undefined;

  priority: CodableConceptModel | undefined;
  billablePeriod: {start?: string; end?: string} | undefined;

  /** The amount claimed. NOT what the patient owes. */
  total: {value?: number; currency?: string} | undefined;

  identifier: any[] | undefined;
  hasIdentifier: boolean | undefined;

  diagnosis: {sequence?: number; diagnosisCodeableConcept?: CodableConceptModel}[] | undefined;
  hasDiagnosis: boolean | undefined;

  careTeam: {sequence?: number; provider?: ReferenceModel; role?: CodableConceptModel}[] | undefined;
  hasCareTeam: boolean | undefined;

  insurance: any[] | undefined;
  hasInsurance: boolean | undefined;

  /** Line items, flattened to what a reader can use: what, when, how much. */
  items:
    | {
        coding: CodingModel | undefined;
        servicedDate: string | undefined;
        quantity: number | undefined;
        net: {value?: number; currency?: string} | undefined;
      }[]
    | undefined;
  hasItems: boolean | undefined;

  constructor(fhirResource: any, fhirVersion?: fhirVersions, fastenOptions?: FastenOptions) {
    super(fastenOptions);
    this.source_resource_type = ResourceType.Claim;
    this.resourceDTO(fhirResource, fhirVersion || fhirVersions.R4);
  }

  commonDTO(fhirResource: any) {
    this.status = _.get(fhirResource, 'status');
    this.use = _.get(fhirResource, 'use');
    // Date only. The time a bill was generated is noise to a reader.
    const created = _.get(fhirResource, 'created');
    this.created = created ? String(created).slice(0, 10) : undefined;

    this.type = _.get(fhirResource, 'type.coding', []);
    this.hasType = Array.isArray(this.type) && this.type.length > 0;
    this.subType = _.get(fhirResource, 'subType');

    this.patient = _.get(fhirResource, 'patient');
    this.provider = _.get(fhirResource, 'provider');
    this.insurer = _.get(fhirResource, 'insurer');

    this.priority = _.get(fhirResource, 'priority');
    this.billablePeriod = _.get(fhirResource, 'billablePeriod');
    this.total = _.get(fhirResource, 'total');

    this.identifier = _.get(fhirResource, 'identifier', []);
    this.hasIdentifier = this.identifier.length > 0;

    this.diagnosis = _.get(fhirResource, 'diagnosis', []);
    this.hasDiagnosis = this.diagnosis.length > 0;

    this.careTeam = _.get(fhirResource, 'careTeam', []);
    this.hasCareTeam = this.careTeam.length > 0;

    this.insurance = _.get(fhirResource, 'insurance', []);
    this.hasInsurance = this.insurance.length > 0;

    const items = _.get(fhirResource, 'item', []);
    this.items = items.map((item: any) => ({
      // R4 uses productOrService; some payers only populate revenue. Take whichever is present
      // rather than showing a line with no description.
      coding: _.get(item, 'productOrService.coding.0') || _.get(item, 'revenue.coding.0'),
      servicedDate: _.get(item, 'servicedDate') || _.get(item, 'servicedPeriod.start'),
      quantity: _.get(item, 'quantity.value'),
      net: _.get(item, 'net'),
    }));
    this.hasItems = this.items.length > 0;

    this.sort_title = this.type?.[0]?.display || this.type?.[0]?.code || 'Claim';
    this.sort_date = this.created ? new Date(this.created) : undefined;
  }

  resourceDTO(fhirResource: any, fhirVersion: fhirVersions) {
    // Claim's shape is stable across the versions this app ingests, so there is one path rather than
    // three near-identical ones. If a version-specific difference turns up, split it then.
    this.commonDTO(fhirResource);
  }
}
