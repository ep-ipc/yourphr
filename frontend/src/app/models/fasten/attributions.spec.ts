import {ATTRIBUTIONS, attributionById, attributionsForContext} from './attributions';

describe('attributions registry', () => {
  it('includes CMS Blue Button with the required non-endorsement sentence', () => {
    const cms = attributionById('cms-blue-button');
    expect(cms).toBeTruthy();
    expect(cms!.body).toContain('not endorsed or certified');
    expect(cms!.body).toContain('Centers for Medicare & Medicaid Services');
    expect(cms!.contexts).toContain('attributions-page');
    expect(cms!.contexts).toContain('medicare-connect');
  });

  it('filters by context', () => {
    const medicare = attributionsForContext('medicare-connect');
    expect(medicare.some((a) => a.id === 'cms-blue-button')).toBeTrue();
    expect(attributionsForContext('footer').length).toBe(0);
  });

  it('lists every entry on the attributions page context', () => {
    const page = attributionsForContext('attributions-page');
    expect(page.length).toBe(ATTRIBUTIONS.length);
  });
});
