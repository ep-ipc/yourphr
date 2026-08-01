import {fhirVersions, ResourceType} from '../constants';
import * as _ from "lodash";
import {CodableConceptModel, hasValue} from '../datatypes/codable-concept-model';
import {ReferenceModel} from '../datatypes/reference-model';
import {FastenDisplayModel} from '../fasten/fasten-display-model';
import {FastenOptions} from '../fasten/fasten-options';

/**
 * FHIR AdverseEvent display model (#449).
 * Harm / near-miss: actuality actual | potential. Date falls back to meta.lastUpdated when
 * clinical date fields are absent (common on SMART/Synthea).
 */
export class AdverseEventModel extends FastenDisplayModel {
  code: CodableConceptModel | undefined

  subject: ReferenceModel | undefined
  description: string | undefined
  event_type: string | undefined
  has_event_type: boolean | undefined
  /** Clinical date when present; else detected / recordedDate / meta.lastUpdated. */
  date: string | undefined
  seriousness: CodableConceptModel | undefined
  has_seriousness: boolean | undefined
  actuality: string | undefined
  event: CodableConceptModel | undefined
  has_event: boolean | undefined
  outcome: CodableConceptModel | undefined
  has_outcome: boolean | undefined
  /** First suspect entity instance reference (MedicationAdministration, Device, …). */
  suspect_entities: { display?: string; reference?: string }[] | undefined
  /** List/title: event text, else first suspect entity label. */
  event_display: string | undefined
  outcome_display: string | undefined
  seriousness_display: string | undefined

  constructor(fhirResource: any, fhirVersion?: fhirVersions, fastenOptions?: FastenOptions) {
    super(fastenOptions)
    this.source_resource_type = ResourceType.AdverseEvent
    this.resourceDTO(fhirResource, fhirVersion || fhirVersions.R4);
  }

  commonDTO(fhirResource: any) {
    this.code = _.get(fhirResource, 'event');
    this.subject = _.get(fhirResource, 'subject');
    this.date =
      _.get(fhirResource, 'date') ||
      _.get(fhirResource, 'detected') ||
      _.get(fhirResource, 'recordedDate') ||
      _.get(fhirResource, 'meta.lastUpdated');

    const seriousness = _.get(fhirResource, 'seriousness');
    if (hasValue(seriousness)) {
      this.seriousness = new CodableConceptModel(seriousness);
      this.has_seriousness = true;
      this.seriousness_display =
        _.get(seriousness, 'text') ||
        _.get(seriousness, 'coding.0.display') ||
        _.get(seriousness, 'coding.0.code');
    } else {
      this.seriousness = undefined;
      this.has_seriousness = false;
    }

    const outcome = _.get(fhirResource, 'outcome');
    if (hasValue(outcome)) {
      this.outcome = new CodableConceptModel(outcome);
      this.has_outcome = true;
      this.outcome_display =
        _.get(outcome, 'text') ||
        _.get(outcome, 'coding.0.display') ||
        _.get(outcome, 'coding.0.code');
    } else {
      this.outcome = undefined;
      this.has_outcome = false;
    }

    this.suspect_entities = (_.get(fhirResource, 'suspectEntity') || [])
      .map((se: any) => {
        const inst = _.get(se, 'instance') || {};
        const display = _.get(inst, 'display');
        const reference = _.get(inst, 'reference');
        const row: { display?: string; reference?: string } = {};
        if (display) { row.display = display; }
        if (reference) { row.reference = reference; }
        return row;
      })
      .filter((x: { display?: string; reference?: string }) => !!(x.display || x.reference));
  }

  stu3DTO(fhirResource: any) {
    this.description = _.get(fhirResource, 'description');
    this.event_type = _.get(fhirResource, 'type', []);
    this.has_event_type = hasValue(this.event_type);
  }

  r4DTO(fhirResource: any) {
    this.actuality = _.get(fhirResource, 'actuality');
    const event = _.get(fhirResource, 'event');
    if (hasValue(event)) {
      this.event = new CodableConceptModel(event);
      this.has_event = true;
    } else {
      this.event = undefined;
      this.has_event = false;
    }

    const eventText =
      _.get(fhirResource, 'event.text') ||
      _.get(fhirResource, 'event.coding.0.display') ||
      _.get(fhirResource, 'event.coding.0.code');
    const firstSuspect = this.suspect_entities?.[0];
    const suspectLabel = firstSuspect?.display || firstSuspect?.reference;
    this.event_display = eventText || suspectLabel;
  }

  resourceDTO(fhirResource: any, fhirVersion: fhirVersions) {
    switch (fhirVersion) {
      case fhirVersions.STU3:
        this.commonDTO(fhirResource)
        this.stu3DTO(fhirResource)
        return
      case fhirVersions.R4:
        this.commonDTO(fhirResource)
        this.r4DTO(fhirResource)
        return
      default:
        break;
    }
  }
}
