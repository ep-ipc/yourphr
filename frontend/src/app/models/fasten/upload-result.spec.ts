import {uploadResultMessage} from './upload-result';

describe('uploadResultMessage', () => {
  const base = {format: 'fhir', received: 0, created: 0, updated: 0, collisions: 0, skipped: 0};

  it('says what was added and refreshed', () => {
    expect(uploadResultMessage({...base, created: 3, updated: 1})).toBe('Added 3 new records. Refreshed 1 record you already had from this file.');
  });

  it('says so when nothing new arrived', () => {
    expect(uploadResultMessage(base)).toBe('Nothing new was added.');
  });

  it('never hides what was left out', () => {
    expect(uploadResultMessage({...base, created: 1, collisions: 2, skipped: 1})).toBe(
      'Added 1 new record. 2 records were left out because another of your connected sources already has them. 1 part of the file could not be read and was skipped.');
  });
});
