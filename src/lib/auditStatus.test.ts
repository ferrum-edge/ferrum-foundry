import { describe, expect, it } from 'vitest';
import { auditCollectionState } from './auditStatus';
import { detailedHealth, auditPipeline } from '@/test/__tests__/healthFixtures';

describe('freshness of audit evidence', () => {
  it.each([
    { isStale: true }, { isFetching: true }, { isLoading: true }, { isError: true },
  ])('a retained detailed snapshot cannot prove disabled while %o', flags => {
    expect(auditCollectionState({ data: detailedHealth, isLoading: false, isError: false, ...flags })).toBe('unknown');
  });
  it('an enabled pipeline from a stale snapshot cannot prove currently enabled', () => {
    expect(auditCollectionState({ data: { ...detailedHealth, audit_pipeline: auditPipeline },
      isLoading: false, isError: false, isStale: true })).toBe('unknown');
  });
});
