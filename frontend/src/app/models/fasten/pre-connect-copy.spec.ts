import {GENERIC_PRE_CONNECT, MEDICARE_PRE_CONNECT, preConnectCopyForProfile} from './pre-connect-copy';

describe('preConnectCopyForProfile', () => {
  it('returns null for none', () => {
    expect(preConnectCopyForProfile('none')).toBeNull();
  });

  it('returns medicare copy', () => {
    expect(preConnectCopyForProfile('medicare')).toEqual(MEDICARE_PRE_CONNECT);
    expect(MEDICARE_PRE_CONNECT.showMedicareAttribution).toBeTrue();
  });

  it('defaults to generic', () => {
    expect(preConnectCopyForProfile('generic')).toEqual(GENERIC_PRE_CONNECT);
    expect(preConnectCopyForProfile('')).toEqual(GENERIC_PRE_CONNECT);
    expect(GENERIC_PRE_CONNECT.showMedicareAttribution).toBeFalse();
  });
});
