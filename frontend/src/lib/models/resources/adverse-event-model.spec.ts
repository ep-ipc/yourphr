import { AdverseEventModel } from './adverse-event-model';
import {CodableConceptModel} from '../datatypes/codable-concept-model';
import * as example1Fixture from "../../fixtures/r4/resources/adverseEvent/example1.json";

describe('AdverseEventModel', () => {
  it('should create an instance', () => {
    expect(new AdverseEventModel({})).toBeTruthy();
  });

  describe('with r4', () => {

    it('should parse example1.json', () => {
      const expected = new AdverseEventModel({})
      expected.subject = {
        "reference": "Patient/example"
      }
      expected.date = "2017-01-29T12:34:56+00:00"
      expected.seriousness = new CodableConceptModel({ coding: [ Object({ system: 'http://terminology.hl7.org/CodeSystem/adverse-event-seriousness', code: 'Non-serious', display: 'Non-serious' }) ] })
      expected.has_seriousness = true
      expected.seriousness_display = 'Non-serious'
      expected.actuality = 'actual'
      expected.event = new CodableConceptModel({
        "coding": [
          {
            "system": "http://snomed.info/sct",
            "code": "304386008",
            "display": "O/E - itchy rash"
          }
        ],
        "text": "This was a mild rash on the left forearm"
      })
      expected.has_event = true
      expected.event_display = 'This was a mild rash on the left forearm'
      expected.code = { coding: [{ system: 'http://snomed.info/sct', code: '304386008', display: 'O/E - itchy rash' } ], text: 'This was a mild rash on the left forearm' }
      expected.has_outcome = false
      expected.suspect_entities = [{ reference: 'Medication/example' }]

      expect(new AdverseEventModel(example1Fixture)).toEqual(expected);
    });

    // SMART Health IT sparse shape (#449) — no event/date; lastUpdated + suspectEntity + outcome
    it('should fall back date to meta.lastUpdated and event to suspectEntity', () => {
      const model = new AdverseEventModel({
        resourceType: 'AdverseEvent',
        id: '2616159',
        meta: { lastUpdated: '2024-12-09T11:50:37.037-05:00' },
        actuality: 'actual',
        subject: { reference: 'Patient/39234650-0229-4aee-975b-c8ee68bab40b' },
        outcome: { text: 'okcool' },
        suspectEntity: [
          { instance: { reference: 'MedicationAdministration/2594415' } },
        ],
      })
      expect(model.date).toEqual('2024-12-09T11:50:37.037-05:00')
      expect(model.actuality).toEqual('actual')
      expect(model.has_event).toBeFalse()
      expect(model.event_display).toEqual('MedicationAdministration/2594415')
      expect(model.outcome_display).toEqual('okcool')
      expect(model.has_outcome).toBeTrue()
      expect(model.suspect_entities).toEqual([{ reference: 'MedicationAdministration/2594415' }])
    })
  })
});
