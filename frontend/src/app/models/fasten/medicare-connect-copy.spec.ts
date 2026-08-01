import {MEDICARE_PRE_CONNECT} from './medicare-connect-copy';

describe('MEDICARE_PRE_CONNECT', () => {
  it('covers collect, store, disconnect, and not medical advice', () => {
    const all = MEDICARE_PRE_CONNECT.intro + ' ' + MEDICARE_PRE_CONNECT.bullets.join(' ');
    expect(all.toLowerCase()).toContain('medicare');
    expect(all.toLowerCase()).toContain('claims');
    expect(all.toLowerCase()).toContain('stored');
    expect(all.toLowerCase()).toContain('disconnect');
    expect(all.toLowerCase()).toContain('remove');
    expect(all.toLowerCase()).toContain('medical advice');
    expect(MEDICARE_PRE_CONNECT.continueLabel.length).toBeGreaterThan(0);
    expect(MEDICARE_PRE_CONNECT.cancelLabel.toLowerCase()).toContain('cancel');
  });
});
