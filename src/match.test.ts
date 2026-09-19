import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, calculateScore, findTopMatches } from './match';
import type { IncidentRecord } from './match';

const mockIncidents: IncidentRecord[] = [
  {
    id: 'INC-001',
    signature: 'abcd',
    service: 'checkout-service',
    error_type: 'PoolExhausted',
    symptoms: 'pool exhausted max 10 connection leak',
    title: 'Pool Leak',
    root_cause: 'Leak',
    fix_summary: 'Raise pool',
    runbook_id: 'RB-001',
    success_count: 5,
    fail_count: 0
  },
  {
    id: 'INC-002',
    signature: 'wxyz',
    service: 'payments-api',
    error_type: 'ETIMEDOUT',
    symptoms: 'etimedout upstream stripe',
    title: 'Stripe Timeout',
    root_cause: 'Slowness',
    fix_summary: 'Raise timeout',
    runbook_id: 'RB-002',
    success_count: 1,
    fail_count: 1
  }
];

describe('jaccardSimilarity', () => {
  it('calculates token similarity correctly', () => {
    const score = jaccardSimilarity('pool exhausted', 'pool exhausted max 10');
    // intersection: pool, exhausted (2)
    // union: pool, exhausted, max, 10 (4)
    // 2 / 4 = 0.5
    expect(score).toBe(0.5);
  });
});

describe('calculateScore', () => {
  it('scores exact matches highly', () => {
    const query = {
      signature: 'abcd',
      service: 'checkout-service',
      errorType: 'PoolExhausted',
      keywords: ['pool', 'exhausted']
    };
    
    const { score, band } = calculateScore(query, mockIncidents[0]);
    // signature(0.4) + service(0.25) + token(0.25 * 0.5) + err(0.1) = 0.4+0.25+0.125+0.1 = 0.875
    // successRate = 5/5 = 1. final = 0.875 * (0.7 + 0.3) = 0.875
    expect(score).toBeGreaterThan(0.8);
    expect(band).toBe('strong');
  });
});

describe('findTopMatches', () => {
  it('returns sorted top matches', () => {
    const query = {
      signature: 'abcd',
      service: 'checkout-service',
      errorType: 'PoolExhausted',
      keywords: ['pool', 'exhausted']
    };
    const matches = findTopMatches(query, mockIncidents);
    expect(matches).toHaveLength(1); // the other one falls below 0.3 threshold
    expect(matches[0].id).toBe('INC-001');
    expect(matches[0].band).toBe('strong');
  });
});
