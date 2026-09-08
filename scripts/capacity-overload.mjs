import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { responseOutcome } from './capacity-summary.mjs';

export async function verifyCapacityOverload({ base, token, signal, sample, upload }) {
  const held = [];
  const initial = await sample();
  assert.equal(initial.uploads.active, 0, 'Overload probe requires idle upload admission');
  async function waitActive(expected) {
    const deadline = Date.now() + 10_000;
    do {
      signal.throwIfAborted();
      const value = await sample();
      if (value.uploads.active === expected) return value;
      await delay(50, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error('Upload admission did not reach expected active count');
  }
  try {
    for (let index = 0; index < initial.uploads.limit; index++) {
      signal.throwIfAborted();
      const request = http.request(new URL('/api/uploads', base), {
        method: 'POST', signal, timeout: 15_000,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=capacity-stalled', 'content-length': '1024' },
      });
      request.on('error', () => {});
      request.on('timeout', () => request.destroy());
      request.on('response', response => response.resume());
      const closed = new Promise(resolve => request.once('close', resolve));
      held.push({ request, closed });
      request.write('--capacity-stalled\r\nContent-Disposition: form-data; name="file"; filename="stalled.txt"\r\nContent-Type: text/plain\r\n\r\nx');
      await waitActive(index + 1);
    }
    const { response, payload } = await upload('capacity-overload.txt', new Uint8Array([120]));
    assert.equal(responseOutcome('upload', response, payload), 'upload_busy', 'A full admission limit must reject a new upload with UPLOAD_BUSY and Retry-After');
    const full = await sample();
    assert.equal(full.uploads.active, initial.uploads.limit);
    assert.equal(full.uploads.rejectedTotal, initial.uploads.rejectedTotal + 1);
  } finally {
    for (const { request } of held) request.destroy();
    await Promise.all(held.map(item => item.closed));
  }
  await waitActive(0);
  return { status: 'passed', heldRequests: initial.uploads.limit, rejectedRequests: 1, activeAfterRelease: 0 };
}
