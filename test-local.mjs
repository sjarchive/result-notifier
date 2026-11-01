/**
 * ==============================================================================
 * Local Verification Test for VMOU Result Notifier
 * ==============================================================================
 * Tests checker execution against the live VMOU website without needing Wrangler.
 * ==============================================================================
 */
import { checkVMOUResults, TARGET_COURSE_DEFINITIONS, resolveTargetDefinitions, isTargetProgramme } from './src/checker.js';
import {
  formatIST,
  evaluateDeadManSwitch,
  computeResultsFingerprint,
  savePushSubscription,
  getPushSubscriptions,
  removePushSubscription
} from './src/utils.js';
import { sendEmail, sendTelegram, sendWebPush } from './src/notifications.js';

async function runLocalVerification() {
  console.log('------------------------------------------------------------');
  console.log('🧪 Starting VMOU Result Notifier Local Verification');
  console.log(`⏱️ Current Local Time: ${formatIST(new Date())}`);
  console.log('------------------------------------------------------------\n');

  const targets = resolveTargetDefinitions({
    TARGET_PROGRAMME_CODE: 'MAPSN-2',
    TARGET_PROGRAMME_NAME: 'M.A. POLITICAL SCIENCE (Semester-II)'
  });

  // Test 1: Programme Matcher Integrity
  console.log('Test 1: Validating Target Programme Matching Logic...');
  const testPhrases = [
    { text: 'M.A. POLITICAL SCIENCE (Semester-II)', expected: true },
    { text: 'M.A. POLITICAL SCIENCE (SEMESTER 2)', expected: true },
    { text: 'M.A.POLITICAL SCIENCE (Sem-II)', expected: true },
    { text: 'MA POLITICAL SCIENCE (Sem II) Examination Result', expected: true },
    { text: 'M.A. POLITICAL SCIENCE (Semester-2)', expected: true },
    { text: 'MAPSN-2', expected: true },
    { text: 'MAPSN-2 Examination Result Declared on 21/10/2026', expected: true },
    { text: 'm.a. political science (semester-ii)', expected: true },
    { text: 'M.A. POLITICAL SCIENCE (FINAL)', expected: false },
    { text: 'M.A. POLITICAL SCIENCE (Semester-I)', expected: false },
    { text: 'M.A. POLICE ADMINISTRATION (Semester-I)', expected: false },
    { text: 'M.A. POLICE ADMINISTRATION (Semester-III)', expected: false },
    { text: 'BACHELOR OF ARTS (ADDITIONAL SUBJECT-POLITICAL SCIENCE) BAA(PS)', expected: false },
    { text: 'MASTER OF ARTS PSYCHOLOGY (Semester-II) MAPSYN-2', expected: false }
  ];

  for (const { text, expected } of testPhrases) {
    const actual = isTargetProgramme(text, targets);
    const pass = actual === expected;
    console.log(`  ${pass ? '✅' : '❌'} "${text}" -> Matched: ${actual} (Expected: ${expected})`);
    if (!pass) throw new Error(`Programme matcher test failed for phrase: ${text}`);
  }
  console.log('Test 1 Passed!\n');

  // Test 2: Dead Man's Switch Evaluation
  console.log("Test 2: Validating Dead Man's Switch logic...");
  const recentState = { lastCheckTimestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString() }; // 3 min ago
  const oldState = { lastCheckTimestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString() }; // 15 min ago

  const d1 = evaluateDeadManSwitch(recentState, 10);
  const d2 = evaluateDeadManSwitch(oldState, 10);
  console.log(`  3 mins ago: tripped = ${d1.tripped} (Expected: false) -> ${!d1.tripped ? '✅' : '❌'}`);
  console.log(`  15 mins ago: tripped = ${d2.tripped} (Expected: true) -> ${d2.tripped ? '✅' : '❌'}`);
  if (d1.tripped || !d2.tripped) throw new Error("Dead Man's Switch logic failed");
  console.log('Test 2 Passed!\n');

  // Test 3: Notification Handlers Graceful Missing-Secret Checks
  console.log('Test 3: Validating Notification Handlers with unconfigured secrets...');
  const emptyEnv = {};
  const mockPayload = {
    matches: [{ courseName: 'M.A. POLITICAL SCIENCE (Semester-II) Examination Result', declaredDate: '21/10/2026' }],
    portalUrl: 'https://online.vmou.ac.in/results.aspx',
    checkTimestampIST: formatIST(new Date())
  };

  const emailRes = await sendEmail(emptyEnv, mockPayload);
  const tgRes = await sendTelegram(emptyEnv, mockPayload);
  const pushRes = await sendWebPush(emptyEnv, mockPayload);

  console.log(`  Email skipped cleanly: ${emailRes.skipped} -> ${emailRes.skipped ? '✅' : '❌'}`);
  console.log(`  Telegram skipped cleanly: ${tgRes.skipped} -> ${tgRes.skipped ? '✅' : '❌'}`);
  console.log(`  Web Push skipped cleanly: ${pushRes.skipped} -> ${pushRes.skipped ? '✅' : '❌'}`);
  if (!emailRes.skipped || !tgRes.skipped || !pushRes.skipped) throw new Error('Notification skip failed');
  console.log('Test 3 Passed!\n');

  // Test 4: Web Push Subscription State Management
  console.log('Test 4: Validating Web Push Subscription storage helpers...');
  const mockSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-token-12345',
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9Eg0mNuW5Ak1CGnx30',
      auth: 'tBHItJI5svbpez7KI4CCXg'
    }
  };
  const saveRes = await savePushSubscription(null, mockSub, 'Mozilla/5.0 TestBrowser');
  console.log(`  Saved mock subscription: count = ${saveRes.count} -> ${saveRes.count >= 1 ? '✅' : '❌'}`);
  const subs = await getPushSubscriptions(null);
  const found = subs.some(s => s.endpoint === mockSub.endpoint);
  console.log(`  Retrieved subscription: found = ${found} -> ${found ? '✅' : '❌'}`);
  await removePushSubscription(null, mockSub.endpoint);
  const remaining = await getPushSubscriptions(null);
  console.log(`  Removed subscription: remaining = ${remaining.length} -> ${remaining.length === 0 ? '✅' : '❌'}`);
  if (!found || remaining.length !== 0) throw new Error('Web Push subscription state test failed');
  console.log('Test 4 Passed!\n');

  // Test 5: Live Check against https://online.vmou.ac.in/results.aspx
  console.log('Test 5: Executing Live Portal Check against https://online.vmou.ac.in/results.aspx...');
  const checkResult = await checkVMOUResults({
    TARGET_URL: 'https://online.vmou.ac.in/results.aspx',
    TARGET_SESSION: 'JUNE26',
    TARGET_PROGRAMME_CODE: 'MAPSN-2',
    TARGET_PROGRAMME_NAME: 'M.A. POLITICAL SCIENCE (Semester-II)'
  });

  console.log(`  Check Success: ${checkResult.success}`);
  console.log(`  Total declared results on portal: ${checkResult.totalDeclaredOnPage}`);
  console.log(`  Target matches found: ${checkResult.matches.length}`);
  console.log(`  Execution duration: ${checkResult.durationMs}ms`);

  if (checkResult.matches.length > 0) {
    console.log('  Detected Target Matches:');
    checkResult.matches.forEach((m, idx) => {
      console.log(`    ${idx + 1}. [${m.targetKey}] ${m.courseName} (Declared: ${m.declaredDate})`);
    });
  }

  const fingerprint = computeResultsFingerprint(checkResult.matches);
  console.log(`  Results Fingerprint: "${fingerprint}"`);
  console.log('Test 5 Passed!\n');

  // Test 6: Anti-Duplicate Lock, Cooldown & Favicon Verification
  console.log('Test 6: Validating Anti-Duplicate Concurrency Lock, Cooldown & Tab Favicon...');
  const { acquireDispatchLock, releaseDispatchLock, checkNotificationCooldown } = await import('./src/utils.js');
  const { FAVICON_SVG } = await import('./src/index.js');

  // 6a. Concurrency Lock
  const lock1 = await acquireDispatchLock(null, 2);
  const lock2 = await acquireDispatchLock(null, 2); // Should be blocked!
  await releaseDispatchLock(null);
  const lock3 = await acquireDispatchLock(null, 2); // Should be available after release!
  await releaseDispatchLock(null);

  console.log(`  Lock 1 acquired: ${lock1} (Expected: true) -> ${lock1 ? '✅' : '❌'}`);
  console.log(`  Lock 2 blocked: ${!lock2} (Expected: true) -> ${!lock2 ? '✅' : '❌'}`);
  console.log(`  Lock 3 re-acquired after release: ${lock3} (Expected: true) -> ${lock3 ? '✅' : '❌'}`);
  if (!lock1 || lock2 || !lock3) throw new Error('Concurrency lock validation failed');

  // 6b. Cooldown Guard
  const coolStateRecent = { lastNotificationTimestamp: new Date(Date.now() - 30 * 1000).toISOString() }; // 30s ago
  const coolStateOld = { lastNotificationTimestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString() }; // 10 min ago
  const cdRecent = checkNotificationCooldown(coolStateRecent, 5); // 5 min cooldown
  const cdOld = checkNotificationCooldown(coolStateOld, 5);

  console.log(`  Cooldown recent (30s ago): inCooldown = ${cdRecent.inCooldown} (Expected: true) -> ${cdRecent.inCooldown ? '✅' : '❌'}`);
  console.log(`  Cooldown old (10m ago): inCooldown = ${cdOld.inCooldown} (Expected: false) -> ${!cdOld.inCooldown ? '✅' : '❌'}`);
  if (!cdRecent.inCooldown || cdOld.inCooldown) throw new Error('Notification cooldown validation failed');

  // 6c. Tab Favicon SVG Integrity
  console.log(`  Favicon SVG defined: ${Boolean(FAVICON_SVG && FAVICON_SVG.includes('<svg'))} -> ${Boolean(FAVICON_SVG && FAVICON_SVG.includes('<svg')) ? '✅' : '❌'}`);
  if (!FAVICON_SVG || !FAVICON_SVG.includes('<svg')) throw new Error('Tab favicon SVG validation failed');
  console.log('Test 6 Passed!\n');

  console.log('============================================================');
  console.log('🎉 ALL LOCAL VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('============================================================');
}

runLocalVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
