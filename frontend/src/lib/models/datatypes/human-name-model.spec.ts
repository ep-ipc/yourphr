import { HumanNameModel, formatHumanName } from './human-name-model';
import {AddressModel} from './address-model';
import * as fixture from "../../fixtures/r4/datatypes/human-name.json"

describe('HumanNameModel', () => {
  it('should create an instance', () => {
    expect(new HumanNameModel({})).toBeTruthy();
  });

  it('should parse fhirdata', () => {
    const expectedHumanName = new HumanNameModel({})
    expectedHumanName.givenName = 'Peter, James'
    expectedHumanName.familyName = 'Windsor'
    expectedHumanName.suffix = ''
    expectedHumanName.use = 'maiden'
    expectedHumanName.displayName = 'Peter, James Windsor'
    // expectedHumanName.header = 'Peter, James Windsor'

    expect(new HumanNameModel(fixture)).toEqual(expectedHumanName);
    expect('Peter, James Windsor').toEqual(expectedHumanName.displayName);
  });
});

// #525: /web/practitioners showed names in mixed order — "Smith, John" beside "John Smith" —
// because each row rendered HumanName.text exactly as its source system wrote it.
describe('formatHumanName', () => {
  it('should order structured parts as given then family, whatever text says', () => {
    expect(formatHumanName({
      text: 'Smith, John',
      given: ['John'],
      family: 'Smith',
    })).toEqual('John Smith');
  });

  it('should be consistent across sources that disagree', () => {
    const a = formatHumanName({text: 'Smith, John', given: ['John'], family: 'Smith'});
    const b = formatHumanName({text: 'John Smith', given: ['John'], family: 'Smith'});

    expect(a).toEqual(b);
  });

  it('should keep a suffix, since that is how people identify a clinician', () => {
    expect(formatHumanName({given: ['Jane'], family: 'Doe', suffix: ['MD']})).toEqual('Jane Doe MD');
  });

  it('should join multiple given names', () => {
    expect(formatHumanName({given: ['Peter', 'James'], family: 'Windsor'})).toEqual('Peter James Windsor');
  });

  // Only when there is nothing structured to use — never prefer free text over stated parts.
  it('should fall back to text when no structured parts exist', () => {
    expect(formatHumanName({text: 'Springfield Clinic'})).toEqual('Springfield Clinic');
  });

  it('should return an empty string for an absent name', () => {
    expect(formatHumanName(undefined)).toEqual('');
    expect(formatHumanName({})).toEqual('');
  });
});
