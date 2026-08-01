import { resourceDetailCrumbTitle } from './resource-detail.component';
import { ResourceFhir } from '../../models/fasten/resource_fhir';

describe('resourceDetailCrumbTitle', () => {
  it('formats Encounter type as display (code) from FHIR only', () => {
    const resource = new ResourceFhir({
      source_resource_id: 'dd1788bf-e818-49fd-b0b3-ff5661927736',
      source_resource_type: 'Encounter',
      resource_raw: {
        resourceType: 'Encounter',
        id: 'dd1788bf-e818-49fd-b0b3-ff5661927736',
        type: [{
          coding: [{
            system: 'http://snomed.info/sct',
            code: '308646001',
            display: 'Death Certification',
          }],
          text: 'Death Certification',
        }],
      },
    });
    expect(resourceDetailCrumbTitle(resource, null)).toBe('Death Certification (308646001)');
  });

  it('falls back to source_resource_id when no title fields exist', () => {
    const resource = new ResourceFhir({
      source_resource_id: 'abc-123',
      resource_raw: { resourceType: 'Basic', id: 'abc-123' },
    });
    expect(resourceDetailCrumbTitle(resource, null)).toBe('abc-123');
  });
});
