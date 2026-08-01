import {fhirVersions, ResourceType} from '../constants';
import * as _ from "lodash";
import {CodableConceptModel} from '../datatypes/codable-concept-model';
import {ReferenceModel} from '../datatypes/reference-model';
import {FastenDisplayModel} from '../fasten/fasten-display-model';
import {FastenOptions} from '../fasten/fasten-options';

/**
 * FHIR R4 Consent display model (#440).
 * Patient-legible fields only — no fabrication when providers omit data.
 */
export class ConsentModel extends FastenDisplayModel {
  title: string | undefined
  status: string | undefined
  scope: CodableConceptModel | undefined
  category: CodableConceptModel[] | undefined
  category_display: string | undefined
  patient: ReferenceModel | undefined
  date_time: string | undefined
  performers: ReferenceModel[] | undefined
  document_title: string | undefined
  document_content_type: string | undefined
  policy_rule: CodableConceptModel | undefined
  policy_display: string | undefined
  provision_type: string | undefined
  provision_period_start: string | undefined
  verified: boolean | undefined
  verification_date: string | undefined

  constructor(fhirResource: any, fhirVersion?: fhirVersions, fastenOptions?: FastenOptions) {
    super(fastenOptions)
    this.source_resource_type = ResourceType.Consent
    this.resourceDTO(fhirResource, fhirVersion || fhirVersions.R4);
  }

  commonDTO(fhirResource: any) {
    this.status = _.get(fhirResource, 'status', '');
    this.scope = _.get(fhirResource, 'scope');
    this.category = _.get(fhirResource, 'category') || [];
    this.category_display =
      _.get(fhirResource, 'category.0.text') ||
      _.get(fhirResource, 'category.0.coding.0.display') ||
      _.get(fhirResource, 'category.0.coding.0.code');
    this.patient = _.get(fhirResource, 'patient');
    this.date_time = _.get(fhirResource, 'dateTime');
    this.performers = _.get(fhirResource, 'performer') || [];
    this.document_title = _.get(fhirResource, 'sourceAttachment.title');
    this.document_content_type = _.get(fhirResource, 'sourceAttachment.contentType');
    this.policy_rule = _.get(fhirResource, 'policyRule');
    this.policy_display =
      _.get(fhirResource, 'policyRule.coding.0.display') ||
      _.get(fhirResource, 'policyRule.text') ||
      _.get(fhirResource, 'policyRule.coding.0.code');
    this.provision_type = _.get(fhirResource, 'provision.type');
    this.provision_period_start = _.get(fhirResource, 'provision.period.start');
    this.verified = _.get(fhirResource, 'verification.0.verified');
    this.verification_date = _.get(fhirResource, 'verification.0.verificationDate');

    this.title =
      this.document_title ||
      this.category_display ||
      _.get(fhirResource, 'scope.coding.0.display') ||
      _.get(fhirResource, 'scope.text') ||
      'Consent';
  }

  resourceDTO(fhirResource: any, fhirVersion: fhirVersions) {
    switch (fhirVersion) {
      case fhirVersions.DSTU2:
      case fhirVersions.STU3:
      case fhirVersions.R4:
        this.commonDTO(fhirResource)
        return
      default:
        throw Error('Unrecognized the fhir version property type.');
    }
  }
}
