import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeHtmlEntities,
  resolveTargetDefinitions,
  isTargetProgramme,
  parseDeclaredResultsTable,
  extractReadableText,
  identifyTargetMatches
} from './src/checker.js';

import {
  parseSafeInt,
  getState,
  updateState,
  recordCheckSuccess,
  shouldDispatchNotification,
  acquireDispatchLock,
  releaseDispatchLock,
  checkNotificationCooldown,
  evaluateDeadManSwitch,
  validatePushSubscription,
  savePushSubscription,
  removePushSubscription,
  resetInMemoryState
} from './src/utils.js';

import { sendEmail, sendTelegram, sendWebPush } from './src/notifications.js';
import worker, { FAVICON_SVG, runCheckPipeline } from './src/index.js';

function createMockKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    }
  };
}

test('decodeHtmlEntities decodes named/numeric entities without double-unescaping &amp;', () => {
  assert.equal(decodeHtmlEntities('M.A. &amp; M.Sc. &nbsp; &#39;Test&#39; &#x28;II&#x29;'), "M.A. & M.Sc.   'Test' (II)");
  assert.equal(decodeHtmlEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
});

test('isTargetProgramme matches valid variations and rejects prefix/suffix collisions', () => {
  const targets = resolveTargetDefinitions({
    TARGET_PROGRAMME_CODE: 'MAPSN-2',
    TARGET_PROGRAMME_NAME: 'M.A. POLITICAL SCIENCE (Semester-II)'
  });

  assert.equal(isTargetProgramme('M.A. POLITICAL SCIENCE (Semester-II)', targets), true);
  assert.equal(isTargetProgramme('M.A. POLITICAL SCIENCE (SEMESTER 2)', targets), true);
  assert.equal(isTargetProgramme('M.A.POLITICAL SCIENCE (Sem-II)', targets), true);
  assert.equal(isTargetProgramme('MA POLITICAL SCIENCE (Sem II) Examination Result', targets), true);
  assert.equal(isTargetProgramme('MAPSN-2', targets), true);
  assert.equal(isTargetProgramme('MAPSN-2 Examination Result Declared on 21/10/2026', targets), true);
  assert.equal(isTargetProgramme('MAPSN2', targets), true);

  assert.equal(isTargetProgramme('MAPSN-20', targets), false);
  assert.equal(isTargetProgramme('MAPSN-21 Examination Result', targets), false);
  assert.equal(isTargetProgramme('MAPSN-2A', targets), false);
  assert.equal(isTargetProgramme('XMAPSN-2', targets), false);
  assert.equal(isTargetProgramme('M.A. POLITICAL SCIENCE (Semester-20)', targets), false);
  assert.equal(isTargetProgramme('M.A. POLITICAL SCIENCE (Semester-I)', targets), false);
  assert.equal(isTargetProgramme('M.A. POLITICAL SCIENCE (FINAL)', targets), false);
  assert.equal(isTargetProgramme('MASTER OF ARTS PSYCHOLOGY (Semester-II) MAPSYN-2', targets), false);
});

test('parseDeclaredResultsTable parses VMOU ASP.NET GridView table accurately', () => {
  const html = `
    <table id="OtherContentPlaceHolder_gvResultList">
      <tr><th>SL. NO.</th><th>PROGRAMME</th><th>PROGRAMME CODE</th><th>DATE OF DECLARATION</th><th>EXAM SESSION</th></tr>
      <tr><td>1</td><td>BACHELOR OF JOURNALISM (Semester-I)</td><td>BJN-1</td><td>21/10/2026</td><td>JUNE26</td></tr>
      <tr><td>2</td><td>M.A. POLITICAL SCIENCE (Semester-II) &amp; Honours</td><td>MAPSN-2</td><td>22/10/2026</td><td>DEC25</td></tr>
      <tr><td>3</td><td>M.A. POLITICAL SCIENCE (Semester-II)</td><td>MAPSN-2</td><td>25/11/2026</td><td>JUNE26</td></tr>
    </table>
  `;
  const rows = parseDeclaredResultsTable(html);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].courseName, 'M.A. POLITICAL SCIENCE (Semester-II) & Honours');
  assert.equal(rows[2].examSession, 'JUNE26');
});

test('identifyTargetMatches avoids false positives from other sessions in fallback scan', () => {
  const targets = resolveTargetDefinitions({
    TARGET_PROGRAMME_CODE: 'MAPSN-2',
    TARGET_PROGRAMME_NAME: 'M.A. POLITICAL SCIENCE (Semester-II)'
  });

  const html = `
    <table>
      <tr><th>SL. NO.</th><th>PROGRAMME</th><th>CODE</th><th>DATE</th><th>SESSION</th></tr>
      <tr><td>1</td><td>M.A. POLITICAL SCIENCE (Semester-II)</td><td>MAPSN-2</td><td>10/04/2026</td><td>DEC25</td></tr>
    </table>
  `;
  const rows = parseDeclaredResultsTable(html);
  const readableText = extractReadableText(html);

  assert.equal(identifyTargetMatches(rows, targets, 'JUNE26', readableText).length, 0);
  assert.equal(identifyTargetMatches(rows, targets, 'DEC25', readableText).length, 1);
});

test('parseSafeInt, evaluateDeadManSwitch, and in-memory state work reliably', async () => {
  resetInMemoryState();
  assert.equal(parseSafeInt('abc', 3, { min: 0 }), 3);
  assert.equal(parseSafeInt('0', 3, { min: 0 }), 0);

  const oldState = { lastCheckTimestamp: new Date(Date.now() - 25 * 60_000).toISOString() };
  assert.equal(evaluateDeadManSwitch(oldState, 10).tripped, true);
  assert.equal(evaluateDeadManSwitch(oldState, 10, { paused: true }).tripped, false);
  assert.equal(Number.isNaN(evaluateDeadManSwitch({ lastCheckTimestamp: 'invalid' }, 10).elapsedMinutes), false);

  await recordCheckSuccess(null, { matches: [] }, 45);
  const state = await getState(null);
  assert.equal(state.totalChecks, 1);
  assert.equal(state.lastCheckStatus, 'success');
  resetInMemoryState();
});

test('notification handlers skip cleanly when disabled or unsubscribed', async () => {
  resetInMemoryState();
  const payload = {
    matches: [{ courseName: 'M.A. POLITICAL SCIENCE (Semester-II)', declaredDate: '25/11/2026' }],
    portalUrl: 'https://online.vmou.ac.in/results.aspx'
  };
  assert.equal((await sendEmail({}, payload)).skipped, true);
  assert.equal((await sendTelegram({}, payload)).skipped, true);
  assert.equal((await sendWebPush({}, payload)).skipped, true);
});

test('concurrency lock, isolated cooldowns, and push subscription validation', async () => {
  resetInMemoryState();
  assert.equal(await acquireDispatchLock(null, 2), true);
  assert.equal(await acquireDispatchLock(null, 2), false);
  await releaseDispatchLock(null);
  assert.equal(await acquireDispatchLock(null, 2), true);
  await releaseDispatchLock(null);

  const state = {
    lastNotificationTimestamp: null,
    lastTestNotificationTimestamp: new Date(Date.now() - 10_000).toISOString()
  };
  assert.equal(checkNotificationCooldown(state, 5, 'lastNotificationTimestamp').inCooldown, false);
  assert.equal(checkNotificationCooldown(state, 1, 'lastTestNotificationTimestamp').inCooldown, true);

  assert.equal(validatePushSubscription({ endpoint: 'https://fcm.googleapis.com/x' }).valid, false);
  const sub = {
    endpoint: '  https://fcm.googleapis.com/fcm/send/test-1  ',
    keys: { p256dh: 'validP256dh', auth: 'validAuth' }
  };
  const saved = await savePushSubscription(null, sub, 'TestBrowser');
  assert.equal(saved.count, 1);
  const removed = await removePushSubscription(null, 'https://fcm.googleapis.com/fcm/send/test-1');
  assert.equal(removed.removed, true);
  assert.equal(removed.count, 0);
  resetInMemoryState();
});

test('worker scheduled, /health, /api/push/subscribe, /test-notify, /sw.js, and / dashboard', async () => {
  const kv = createMockKV();

  // 1. CRON_PAUSED exits without touching KV
  let waitCalled = false;
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: '*/5 * * * *' },
    { CRON_PAUSED: 'true', RESULTS_KV: kv },
    { waitUntil() { waitCalled = true; } }
  );
  assert.equal(waitCalled, false);
  assert.equal(kv.map.size, 0);

  // 2. /health returns 200 paused when CRON_PAUSED=true
  await updateState(kv, {
    lastCheckTimestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
    lastCheckStatus: 'success'
  });
  const healthRes = await worker.fetch(
    new Request('http://localhost/health'),
    { CRON_PAUSED: 'true', RESULTS_KV: kv },
    {}
  );
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, 'paused');
  assert.equal(healthData.deadManSwitch.tripped, false);

  // 3. /api/push/subscribe rejects missing keys with 400
  const badSubRes = await worker.fetch(
    new Request('http://localhost/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/x' } })
    }),
    { RESULTS_KV: kv },
    {}
  );
  assert.equal(badSubRes.status, 400);

  // 4. /test-notify does not poison cooldown when 0 channels succeed
  const t1 = await worker.fetch(new Request('http://localhost/test-notify', { method: 'POST' }), { RESULTS_KV: kv }, {});
  const t2 = await worker.fetch(new Request('http://localhost/test-notify', { method: 'POST' }), { RESULTS_KV: kv }, {});
  assert.equal(t1.status, 400);
  assert.equal(t2.status, 400);

  // 5. runCheckPipeline does not poison notifiedFingerprints when delivery fails/skips
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(`
      <table>
        <tr><th>SL. NO.</th><th>PROGRAMME</th><th>CODE</th><th>DATE</th><th>SESSION</th></tr>
        <tr><td>1</td><td>M.A. POLITICAL SCIENCE (Semester-II)</td><td>MAPSN-2</td><td>25/11/2026</td><td>JUNE26</td></tr>
      </table>
    `, { status: 200 });
    const run = await runCheckPipeline({
      RESULTS_KV: kv,
      TARGET_SESSION: 'JUNE26',
      TARGET_PROGRAMME_CODE: 'MAPSN-2',
      TARGET_PROGRAMME_NAME: 'M.A. POLITICAL SCIENCE (Semester-II)',
      MAX_RETRIES: '0'
    });
    assert.equal(run.success, true);
    assert.equal(run.hasMatches, true);
    const st = await getState(kv);
    assert.equal(st.notifiedFingerprints.length, 0);
    assert.equal(shouldDispatchNotification(st, run.matches), true);
  } finally {
    globalThis.fetch = origFetch;
  }

  // 6. /sw.js only focuses dashboard on open_dashboard action
  const swText = await (await worker.fetch(new Request('http://localhost/sw.js'), {}, {})).text();
  assert.match(swText, /if\s*\(isDashboardAction\)/);

  // 7. Dashboard restricts selection to .selectable copyable elements
  const html = await (await worker.fetch(
    new Request('http://localhost/'),
    { RESULTS_KV: kv, CRON_PAUSED: 'true', TARGET_PROGRAMME_CODE: 'MAPSN-2', TARGET_SESSION: 'JUNE26' },
    {}
  )).text();
  assert.match(html, /user-select:\s*none;/);
  assert.match(html, /\.selectable[\s\S]*user-select:\s*text;/);
  assert.match(html, /data-copyable="true"[^>]*>MAPSN-2</);
  assert.ok(FAVICON_SVG.includes('<svg'));
});
