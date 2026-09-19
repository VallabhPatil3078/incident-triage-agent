export interface IncidentRecord {
  id: string;
  signature: string;
  service: string;
  error_type: string;
  symptoms: string;
  title: string;
  root_cause: string;
  fix_summary: string;
  runbook_id: string;
  success_count: number;
  fail_count: number;
}

export function jaccardSimilarity(textA: string, textB: string): number {
  if (!textA && !textB) return 1;
  if (!textA || !textB) return 0;
  
  const tokensA = new Set(textA.toLowerCase().split(/\s+/));
  const tokensB = new Set(textB.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  
  return intersection.size / union.size;
}

export function calculateScore(
  query: { signature: string, service: string, errorType: string, keywords: string[] },
  incident: IncidentRecord
): { score: number, band: string } {
  const signatureExact = query.signature === incident.signature ? 1 : 0;
  
  let serviceMatch = 0;
  if (query.service && incident.service) {
    if (query.service.toLowerCase() === incident.service.toLowerCase()) serviceMatch = 1;
    else if (query.service.split('-')[0] === incident.service.split('-')[0]) serviceMatch = 0.5;
  }
  
  const keywordText = query.keywords.join(' ');
  const tokenMatch = jaccardSimilarity(keywordText, incident.symptoms);
  
  const errorTypeMatch = query.errorType === incident.error_type ? 1 : 0;
  
  let score = (0.40 * signatureExact) +
              (0.25 * serviceMatch) +
              (0.25 * tokenMatch) +
              (0.10 * errorTypeMatch);
              
  const totalAttempts = incident.success_count + incident.fail_count;
  const successRate = totalAttempts > 0 ? (incident.success_count / totalAttempts) : 0.5;
  
  const finalScore = score * (0.7 + (0.3 * successRate));
  
  let band = 'none';
  if (finalScore >= 0.60) band = 'strong';
  else if (finalScore >= 0.30) band = 'possible';
  
  return { score: finalScore, band };
}

export function findTopMatches(
  query: { signature: string, service: string, errorType: string, keywords: string[] },
  incidents: IncidentRecord[],
  limit = 3
) {
  const scored = incidents.map(inc => {
    const { score, band } = calculateScore(query, inc);
    return { ...inc, match_score: score, match_band: band };
  });
  
  // Filter out 'none' and sort by score
  const filtered = scored.filter(s => s.match_band !== 'none');
  filtered.sort((a, b) => b.match_score - a.match_score);
  
  return filtered.slice(0, limit).map(s => ({
    id: s.id,
    score: s.match_score,
    band: s.match_band,
    title: s.title,
    rootCause: s.root_cause,
    fixSummary: s.fix_summary,
    runbookId: s.runbook_id,
    successRate: (s.success_count + s.fail_count) > 0 ? s.success_count / (s.success_count + s.fail_count) : 0.5
  }));
}
