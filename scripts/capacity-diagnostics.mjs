const names = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AssertionError', 'ZodError']);
const codes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ERR_ASSERTION', 'ERR_INVALID_STATE',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_ABORTED',
]);
const stages = new Set(['request', 'response_body', 'response_contract', 'response_status', 'assertion']);

export function capacityFailure(stage, error) {
  return {
    stage: stages.has(stage) ? stage : 'assertion',
    name: names.has(error?.name) ? error.name : 'OtherError',
    code: codes.has(error?.code) ? error.code : null,
    causeCode: codes.has(error?.cause?.code) ? error.cause.code : null,
  };
}

export function summarizeFailures(observations) {
  const counts = new Map();
  const failures = observations.filter(item => item.outcome === 'failed');
  for (const item of observations) {
    const key = JSON.stringify({ status: item.status ?? null, outcome: item.outcome });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    responses: [...counts].map(([key, count]) => ({ ...JSON.parse(key), count })),
    failureObservations: failures.slice(0, 20).map(item => ({
      operation: item.operation, index: item.index, status: item.status ?? null,
      durationMs: item.durationMs, diagnostic: item.diagnostic,
    })),
    omittedFailures: Math.max(0, failures.length - 20),
  };
}

export async function readCapacityResponse(response) {
  try { return { response, payload: await response.json() }; }
  catch (error) { return { response, payload: null, diagnostic: capacityFailure('response_body', error) }; }
}
