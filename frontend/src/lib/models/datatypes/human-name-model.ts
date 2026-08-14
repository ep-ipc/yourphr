import * as _ from "lodash";

/**
 * A consistently ordered "Given Family" name, built from the STRUCTURED parts.
 *
 * `HumanName.text` is free text written by whichever system produced the record, so one provider
 * sends "Smith, John" and the next sends "John Smith". A list rendered from `text` faithfully
 * reproduces that mixture and looks broken — which is what it is, from the reader's side (#525).
 *
 * Structured `given` and `family` carry the same name with the ambiguity already removed, so prefer
 * them and fall back to `text` only when they are absent. This is not inventing a name: every part
 * used here was stated by the source (#262).
 *
 * Suffix is kept when present ("John Smith MD") because it is how people identify their clinician;
 * prefix is not, because "Dr" in front of a name a list is sorting by given name adds noise.
 */
export function formatHumanName(fhirData: any): string {
  const given = _.flatten([_.get(fhirData, 'given', [])]).filter(Boolean).join(' ');
  const family = _.flatten([_.get(fhirData, 'family', '')]).filter(Boolean).join(' ');
  const suffix = _.flatten([_.get(fhirData, 'suffix', [])]).filter(Boolean).join(' ');

  const structured = `${given} ${family}`.trim();
  if (!structured) {
    return (_.get(fhirData, 'text') || '').trim();
  }
  return suffix ? `${structured} ${suffix}` : structured;
}

export class HumanNameModel {
  givenName: string
  familyName: string
  suffix: string
  textName: string
  use: string
  displayName: string


  constructor(fhirData: any) {
    this.givenName = _.get(fhirData, 'given', []).join(', ');
    this.familyName = _.flatten(Array(_.get(fhirData, 'family', ''))).join(', ');
    this.suffix = _.get(fhirData, 'suffix', []).join(', ');
    this.textName = _.get(fhirData, 'text');
    this.use = _.get(fhirData, 'use');
    this.displayName = this.textName ? this.textName : `${this.givenName} ${this.familyName}`.trim();
  }
}
