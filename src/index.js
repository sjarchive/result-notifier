/**
 * ==============================================================================
 * VMOU Result Notifier - Main Cloudflare Worker Entry Point
 * ==============================================================================
 * Architecture:
 * 1. Scheduled Event Handler (scheduled):
 *    - Triggered every 5 minutes by Cloudflare's Cron Triggers
 *    - Respects CRON_PAUSED flag to exit cleanly without polling/KV writes
 *    - Executes check with automatic retry (max 3 attempts)
 *    - Persists execution state & timestamps to Cloudflare KV
 *    - Evaluates Dead Man's Switch (alerts if gap > threshold)
 *    - Dispatches notifications via Email, Telegram, and Browser Web Push
 *
 * 2. Fetch Handler (fetch):
 *    - GET  /                           -> Visual Web Dashboard & Push Permission Manager
 *    - GET  /sw.js                      -> Browser Service Worker for Web Push
 *    - GET  /health                     -> Health check probe (JSON)
 *    - GET  /status                     -> Full monitoring telemetry & error history (JSON)
 *    - GET  /api/push/vapid-public-key  -> Public VAPID key for browser subscription
 *    - POST /api/push/subscribe         -> Register browser push subscription in KV
 *    - POST /api/push/unsubscribe       -> Remove browser push subscription from KV
 *    - POST /api/push/test              -> Send test push notification to devices
 *    - POST|GET /check-now              -> On-demand manual check trigger (?force=true)
 *    - POST|GET /test-notify            -> Test all notification channels with mock data
 * ==============================================================================
 */

import {
  logger,
  getNowIso,
  formatIST,
  escapeHtml,
  sanitizeHttpUrl,
  parseSafeInt,
  isCronPaused,
  withRetry,
  getState,
  updateState,
  recordCheckSuccess,
  recordCheckError,
  evaluateDeadManSwitch,
  shouldDispatchNotification,
  recordNotificationDispatched,
  acquireDispatchLock,
  releaseDispatchLock,
  checkNotificationCooldown,
  validatePushSubscription,
  getPushSubscriptions,
  savePushSubscription,
  removePushSubscription,
  DEFAULT_VAPID_PUBLIC_KEY
} from './utils.js';

import { checkVMOUResults } from './checker.js';
import { notifyAllChannels, sendWebPush } from './notifications.js';

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bgGrad)"/>
  <circle cx="50" cy="50" r="42" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-opacity="0.35"/>
  <!-- Graduation Cap Top -->
  <path d="M50 24 L86 40 L50 56 L14 40 Z" fill="#ffffff"/>
  <!-- Skullcap Underneath -->
  <path d="M28 47 L28 62 C28 72 72 72 72 62 L72 47 C65 52 35 52 28 47 Z" fill="#cbd5e1"/>
  <!-- Tassel Button & Cord -->
  <circle cx="50" cy="40" r="3.5" fill="#f59e0b"/>
  <path d="M50 40 Q40 52 42 66" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Tassel Fringe -->
  <path d="M42 66 L39 74 M42 66 L42 75 M42 66 L45 74" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round"/>
</svg>`.trim();

const SERVICE_WORKER_CODE = `
// ==============================================================================
// Service Worker for VMOU University Result Notifier (Browser Push)
// ==============================================================================
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {
    title: '🎓 VMOU Exam Results Declared!',
    body: 'Target programme examination results have been published on the VMOU portal.',
    url: 'https://online.vmou.ac.in/results.aspx',
    tag: 'vmou-result-alert'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch {
      const text = event.data.text();
      if (text) payload.body = text;
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: payload.tag || 'vmou-result-alert',
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: {
      url: payload.url || 'https://online.vmou.ac.in/results.aspx'
    },
    actions: [
      { action: 'open_results', title: '🔗 Check Results' },
      { action: 'open_dashboard', title: '📊 View Monitor' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const dashboardUrl = self.location.origin + '/';
  const isDashboardAction = event.action === 'open_dashboard';
  const targetUrl = isDashboardAction
    ? dashboardUrl
    : ((event.notification.data && event.notification.data.url) || 'https://online.vmou.ac.in/results.aspx');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Only reuse an existing dashboard window when explicitly opening the dashboard.
      // Clicking the notification body or "Check Results" opens the VMOU results portal directly.
      if (isDashboardAction) {
        for (const client of clientList) {
          if (client.url && client.url.startsWith(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
`.trim();

/**
 * Build a mock check result payload reflecting the current Worker env configuration.
 */
function buildTestCheckResult(env = {}) {
  const programmeCode = env.TARGET_PROGRAMME_CODE || 'MAPSN-2';
  const programmeName = env.TARGET_PROGRAMME_NAME || 'M.A. POLITICAL SCIENCE (Semester-II)';
  const targetSession = env.TARGET_SESSION || 'JUNE26';

  return {
    portalUrl: sanitizeHttpUrl(env.TARGET_URL),
    checkTimestamp: getNowIso(),
    checkTimestampIST: formatIST(new Date()),
    matches: [
      {
        targetDefinitionId: 'MA_POLITICAL_SCIENCE_SEM2',
        targetKey: programmeCode,
        courseName: `${programmeName} Examination Result (TEST ALERT)`,
        courseCode: programmeCode,
        declaredDate: new Date().toLocaleDateString('en-GB'),
        examSession: targetSession,
        category: targetSession ? `Exam Session ${targetSession}` : 'Declared Results'
      }
    ]
  };
}

/**
 * Execute a check run, evaluate state, and dispatch notifications if new results are declared.
 *
 * @param {Object} env Cloudflare Worker environment bindings
 * @param {Object} options Configuration flags
 * @param {boolean} options.forceNotification Force sending alerts even if already notified
 * @param {string} options.triggerSource "cron" | "manual_http"
 * @returns {Promise<Object>} Execution result summary
 */
export async function runCheckPipeline(env, { forceNotification = false, triggerSource = 'cron' } = {}) {
  const runStartMs = Date.now();
  const kv = env.RESULTS_KV || null;
  const maxRetries = parseSafeInt(env.MAX_RETRIES, 3, { min: 0, max: 10 });
  const deadManThreshold = parseSafeInt(env.DEAD_MAN_THRESHOLD_MINUTES, 10, { min: 1, max: 1440 });
  const cronPaused = isCronPaused(env);

  logger.info(`=== Starting check iteration [Trigger: ${triggerSource}, Force: ${forceNotification}] ===`);

  // 1. Evaluate Dead Man's Switch from previous state
  const previousState = await getState(kv);
  const deadManStatus = evaluateDeadManSwitch(previousState, deadManThreshold, { paused: cronPaused });

  if (deadManStatus.tripped) {
    logger.warn(`⚠️ [DEAD MAN'S SWITCH] ${deadManStatus.message}`);
  }

  // 2. Perform check with exponential backoff retry
  let checkResult;
  try {
    checkResult = await withRetry(
      () => checkVMOUResults(env),
      {
        maxRetries,
        baseDelayMs: 1500,
        context: `${triggerSource}-check`
      }
    );

    const checkDurationMs = Date.now() - runStartMs;
    await recordCheckSuccess(kv, checkResult, checkDurationMs);

  } catch (checkErr) {
    const errorDurationMs = Date.now() - runStartMs;
    logger.error(`Check pipeline failed: ${checkErr.message}`, {
      durationMs: errorDurationMs
    });
    await recordCheckError(kv, checkErr, errorDurationMs);

    return {
      success: false,
      error: checkErr.message,
      durationMs: errorDurationMs,
      timestamp: getNowIso(),
      deadManStatus
    };
  }

  // 3. Evaluate results & dispatch notifications
  let notificationReport = null;
  const currentState = await getState(kv);

  if (checkResult.hasMatches) {
    const shouldAlert = forceNotification || shouldDispatchNotification(currentState, checkResult.matches);

    if (shouldAlert) {
      // Cooldown guard: prevent sending duplicate bursts (5 min minimum between alerts)
      // Bypassed when forceNotification=true is explicitly requested.
      const cooldownMinutes = 5;
      const cooldown = checkNotificationCooldown(currentState, cooldownMinutes, 'lastNotificationTimestamp');

      if (!forceNotification && cooldown.inCooldown) {
        logger.warn(`⏳ [NOTIFICATION COOLDOWN] Alert suppressed: Sent ${cooldown.elapsedSeconds}s ago (Cooldown: ${cooldownMinutes * 60}s). Skipping duplicate.`);
      } else {
        // Concurrency lock: ensures only ONE worker instance across all Cloudflare PoPs dispatches the notification
        const lockAcquired = await acquireDispatchLock(kv, 60);

        if (!lockAcquired) {
          logger.warn(`🔒 [CONCURRENCY LOCK] Another worker instance is currently dispatching notifications. Skipping duplicate broadcast.`);
        } else {
          try {
            logger.info(`🔔 Target exam results detected! Initiating multi-channel broadcast...`);

            // Broadcast alerts once across channels (protected by concurrency lock)
            notificationReport = await notifyAllChannels(env, checkResult);

            // Only mark the fingerprint as notified if at least one channel actually delivered.
            // If all channels failed or had zero subscribers, keep the fingerprint unnotified
            // so future checks can still alert once delivery succeeds.
            if (notificationReport.anySucceeded) {
              await recordNotificationDispatched(kv, checkResult.matches, notificationReport, {
                markFingerprintNotified: true
              });
            } else {
              logger.warn(`⚠️ No notification channels delivered successfully; fingerprint NOT marked as notified so alerts can retry.`);
              await recordNotificationDispatched(kv, checkResult.matches, notificationReport, {
                markFingerprintNotified: false
              });
            }
          } catch (notifyErr) {
            logger.error(`Notification broadcast threw an unexpected error: ${notifyErr.message}`);
            notificationReport = {
              anySucceeded: false,
              allSucceeded: false,
              error: notifyErr.message
            };
            await recordNotificationDispatched(kv, checkResult.matches, notificationReport, {
              markFingerprintNotified: false
            });
          } finally {
            await releaseDispatchLock(kv);
          }
        }
      }
    } else {
      logger.info(`ℹ️ Target results are active on portal, but alert was previously dispatched. Skipping duplicate notification.`);
    }
  } else {
    const targetName = env.TARGET_PROGRAMME_NAME || 'M.A. Political Science Sem-II';
    const targetCode = env.TARGET_PROGRAMME_CODE || 'MAPSN-2';
    logger.info(`Checked ${checkResult.totalDeclaredOnPage} declared results. No target programme (${targetName} / ${targetCode}) detected yet.`);
  }

  const totalDurationMs = Date.now() - runStartMs;

  return {
    success: true,
    triggerSource,
    forceNotification,
    durationMs: totalDurationMs,
    timestamp: getNowIso(),
    timestampIST: formatIST(new Date()),
    hasMatches: checkResult.hasMatches,
    matches: checkResult.matches,
    totalDeclaredOnPage: checkResult.totalDeclaredOnPage,
    notificationReport,
    deadManStatus
  };
}

export default {
  /**
   * ----------------------------------------------------------------------------
   * Scheduled Event Handler (Cloudflare Cron Triggers)
   * ----------------------------------------------------------------------------
   * Runs every 5 minutes (see [triggers].crons in wrangler.toml)
   */
  async scheduled(controller, env, ctx) {
    const scheduledTime = controller.scheduledTime;
    const cronExpression = controller.cron;

    // Monitoring PAUSED via CRON_PAUSED (wrangler.toml [vars]): exit before
    // doing any work. The trigger still fires, but no portal checks,
    // notifications or KV writes happen. Set CRON_PAUSED = "false" to resume.
    if (isCronPaused(env)) {
      logger.info(`[Scheduled Event] Cron "${cronExpression}" fired but monitoring is PAUSED (CRON_PAUSED=true) - skipping`);
      return;
    }

    logger.info(`[Scheduled Event] Cron trigger fired: "${cronExpression}" (Scheduled: ${new Date(scheduledTime).toISOString()})`);

    // Use ctx.waitUntil to ensure asynchronous execution finishes before worker exits
    ctx.waitUntil(
      runCheckPipeline(env, {
        forceNotification: false,
        triggerSource: 'cron'
      }).catch(err => {
        logger.error(`Unhandled error inside scheduled event: ${err.message}`);
      })
    );
  },

  /**
   * ----------------------------------------------------------------------------
   * Fetch Handler (HTTP Endpoints & Monitoring Dashboard)
   * ----------------------------------------------------------------------------
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.RESULTS_KV || null;
    const cronPaused = isCronPaused(env);

    // CORS Headers for API consumers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ------------------------------------------------------------------------
      // GET /health - Lightweight JSON health probe
      // ------------------------------------------------------------------------
      if (path === '/health') {
        const state = await getState(kv);
        const deadManThreshold = parseSafeInt(env.DEAD_MAN_THRESHOLD_MINUTES, 10, { min: 1, max: 1440 });
        const deadMan = evaluateDeadManSwitch(state, deadManThreshold, { paused: cronPaused });

        let healthStatus = 'healthy';
        let httpStatus = 200;

        if (cronPaused) {
          healthStatus = 'paused';
          httpStatus = 200;
        } else if (state.lastCheckStatus === 'error') {
          healthStatus = 'unhealthy';
          httpStatus = 503;
        } else if (deadMan.tripped) {
          healthStatus = 'degraded_dead_man';
          httpStatus = 503;
        }

        const body = {
          status: healthStatus,
          cronPaused,
          service: 'vmou-result-notifier',
          version: '1.1.0',
          currentTimestamp: getNowIso(),
          currentTimestampIST: formatIST(new Date()),
          lastCheck: {
            status: state.lastCheckStatus,
            timestamp: state.lastCheckTimestamp,
            timestampIST: state.lastCheckTimestampIST,
            durationMs: state.lastDurationMs,
            consecutiveErrors: state.consecutiveErrors || 0
          },
          deadManSwitch: deadMan,
          targetCoursesDetected: (state.detectedResults || []).length
        };

        return new Response(JSON.stringify(body, null, 2), {
          status: httpStatus,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // GET /sw.js - Browser Service Worker for Push Notifications
      // ------------------------------------------------------------------------
      if (path === '/sw.js') {
        return new Response(SERVICE_WORKER_CODE, {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Service-Worker-Allowed': '/'
          }
        });
      }

      // ------------------------------------------------------------------------
      // GET /api/push/vapid-public-key - VAPID Public Key for client subscription
      // ------------------------------------------------------------------------
      if (path === '/api/push/vapid-public-key') {
        const publicKey = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
        return new Response(JSON.stringify({ publicKey }), {
          status: 200,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // POST /api/push/subscribe - Register browser push subscription in KV
      // ------------------------------------------------------------------------
      if (path === '/api/push/subscribe' && request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        const validation = validatePushSubscription(payload?.subscription);
        if (!validation.valid) {
          return new Response(JSON.stringify({ error: validation.error || 'Invalid push subscription payload' }), {
            status: 400,
            headers: corsHeaders
          });
        }
        const userAgent = request.headers.get('user-agent') || '';
        const subResult = await savePushSubscription(kv, payload.subscription, userAgent);
        return new Response(JSON.stringify({
          success: true,
          message: 'Device subscribed to browser push notifications successfully!',
          totalSubscribers: subResult.count,
          isNew: subResult.isNew
        }, null, 2), {
          status: 200,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // POST /api/push/unsubscribe - Remove browser push subscription from KV
      // ------------------------------------------------------------------------
      if (path === '/api/push/unsubscribe' && request.method === 'POST') {
        const payload = await request.json().catch(() => null);
        if (!payload || typeof payload.endpoint !== 'string' || !payload.endpoint.trim()) {
          return new Response(JSON.stringify({ error: 'Missing subscription endpoint' }), {
            status: 400,
            headers: corsHeaders
          });
        }
        const unsubResult = await removePushSubscription(kv, payload.endpoint);
        return new Response(JSON.stringify({
          success: true,
          message: 'Device unsubscribed from browser push notifications',
          removed: unsubResult.removed,
          remainingSubscribers: unsubResult.count
        }, null, 2), {
          status: 200,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // POST | GET /api/push/test - Dispatch test push notification to devices
      // ------------------------------------------------------------------------
      if (path === '/api/push/test') {
        logger.info('Test push notification requested via HTTP');
        const mockCheckResult = buildTestCheckResult(env);
        const pushReport = await sendWebPush(env, mockCheckResult);

        return new Response(JSON.stringify({
          success: pushReport.success && !pushReport.skipped,
          message: pushReport.delivered > 0
            ? 'Test push notification delivered to active devices!'
            : (pushReport.subscribers === 0
                ? 'No active browser subscriptions registered yet. Click "Turn on Push Notifications" on the dashboard first!'
                : (pushReport.error || 'Test push attempt failed to deliver.')),
          report: pushReport
        }, null, 2), {
          status: pushReport.success ? 200 : 502,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // GET /status - Detailed telemetry & error history
      // ------------------------------------------------------------------------
      if (path === '/status') {
        const state = await getState(kv);
        const pushSubs = await getPushSubscriptions(kv);
        const deadManThreshold = parseSafeInt(env.DEAD_MAN_THRESHOLD_MINUTES, 10, { min: 1, max: 1440 });
        const checkIntervalMinutes = parseSafeInt(env.CHECK_INTERVAL_MINUTES, 5, { min: 1, max: 1440 });
        const deadMan = evaluateDeadManSwitch(state, deadManThreshold, { paused: cronPaused });

        // Email & Telegram are TEMPORARILY DISABLED via ENABLE_EMAIL/ENABLE_TELEGRAM vars
        const emailChannelActive = String(env.ENABLE_EMAIL || 'false').trim().toLowerCase() === 'true';
        const telegramChannelActive = String(env.ENABLE_TELEGRAM || 'false').trim().toLowerCase() === 'true';

        const channelConfig = {
          email: emailChannelActive && Boolean(env.RESEND_API_KEY && env.EMAIL_TO),
          telegram: telegramChannelActive && Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
          browserWebPush: true
        };

        const body = {
          service: 'vmou-result-notifier',
          environment: {
            cronPaused,
            targetUrl: sanitizeHttpUrl(env.TARGET_URL),
            targetSession: env.TARGET_SESSION || 'JUNE26',
            targetProgrammeCode: env.TARGET_PROGRAMME_CODE || 'MAPSN-2',
            targetProgrammeName: env.TARGET_PROGRAMME_NAME || 'M.A. POLITICAL SCIENCE (Semester-II)',
            checkIntervalMinutes: String(checkIntervalMinutes),
            deadManThresholdMinutes: deadManThreshold,
            channelsConfigured: channelConfig,
            webPushSubscribersCount: pushSubs.length
          },
          monitorState: state,
          deadManSwitch: deadMan,
          serverTime: {
            iso: getNowIso(),
            ist: formatIST(new Date())
          }
        };

        return new Response(JSON.stringify(body, null, 2), {
          status: 200,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // POST | GET /check-now - Trigger an immediate manual check
      // Query param ?force=true forces notifications to be sent
      // ------------------------------------------------------------------------
      if (path === '/check-now') {
        const forceNotification = url.searchParams.get('force') === 'true';
        logger.info(`Manual check requested via HTTP (force=${forceNotification})`);

        const result = await runCheckPipeline(env, {
          forceNotification,
          triggerSource: 'manual_http'
        });

        return new Response(JSON.stringify(result, null, 2), {
          status: result.success ? 200 : 500,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // POST | GET /test-notify - Test notification channels with mock data
      // Protected by 60s test cooldown (isolated from real result alerts) and lock
      // ------------------------------------------------------------------------
      if (path === '/test-notify') {
        logger.info(`Test notification requested via HTTP`);

        const state = await getState(kv);
        // Strict 60s cooldown on test alerts only (separate from real alert cooldown)
        const cooldown = checkNotificationCooldown(state, 1, 'lastTestNotificationTimestamp');
        if (cooldown.inCooldown) {
          logger.warn(`Test notification rate-limited: Dispatched ${cooldown.elapsedSeconds}s ago (Cooldown: 60s)`);
          return new Response(JSON.stringify({
            success: false,
            rateLimited: true,
            message: `Rate limited: A test notification was already sent ${cooldown.elapsedSeconds}s ago. Please wait ${cooldown.remainingSeconds}s before sending another test alert.`,
            remainingSeconds: cooldown.remainingSeconds
          }, null, 2), {
            status: 429,
            headers: corsHeaders
          });
        }

        const lockAcquired = await acquireDispatchLock(kv, 30);
        if (!lockAcquired) {
          return new Response(JSON.stringify({
            success: false,
            message: 'Another notification broadcast is currently in progress. Please wait a moment.'
          }, null, 2), {
            status: 409,
            headers: corsHeaders
          });
        }

        try {
          const mockCheckResult = buildTestCheckResult(env);
          const notifyReport = await notifyAllChannels(env, mockCheckResult);

          // Only record test cooldown when at least one channel actually delivered,
          // so failed/unsubscribed test attempts do not trigger a 60s lockout.
          if (notifyReport.anySucceeded) {
            await updateState(kv, {
              lastTestNotificationTimestamp: getNowIso(),
              lastNotificationStatus: notifyReport
            });
          } else {
            await updateState(kv, {
              lastNotificationStatus: notifyReport
            });
          }

          const allSkipped = (notifyReport.skippedChannels?.length || 0) === 3;
          const responseMessage = notifyReport.anySucceeded
            ? 'Test notification triggered across all configured channels'
            : (allSkipped
                ? 'No notification channels dispatched: only Browser Web Push is active (Email & Telegram are disabled by configuration) and no devices are subscribed yet. Enable Browser Push on the dashboard first.'
                : 'Test notification dispatch failed on all channels (see report)');

          const statusCode = notifyReport.anySucceeded ? 200 : (allSkipped ? 400 : 502);

          return new Response(JSON.stringify({
            success: notifyReport.anySucceeded,
            message: responseMessage,
            report: notifyReport
          }, null, 2), {
            status: statusCode,
            headers: corsHeaders
          });
        } finally {
          await releaseDispatchLock(kv);
        }
      }

      // ------------------------------------------------------------------------
      // GET /favicon.ico, /favicon.svg, /icon.svg - Tab Logo (Favicon)
      // ------------------------------------------------------------------------
      if (path === '/favicon.ico' || path === '/favicon.svg' || path === '/icon.svg') {
        return new Response(FAVICON_SVG, {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // ------------------------------------------------------------------------
      // GET / - Live Visual Web Dashboard & Push Permission Manager
      // ------------------------------------------------------------------------
      if (path === '/') {
        const state = await getState(kv);
        const pushSubs = await getPushSubscriptions(kv);
        const deadManThreshold = parseSafeInt(env.DEAD_MAN_THRESHOLD_MINUTES, 10, { min: 1, max: 1440 });
        const checkIntervalMinutes = parseSafeInt(env.CHECK_INTERVAL_MINUTES, 5, { min: 1, max: 1440 });
        const deadMan = evaluateDeadManSwitch(state, deadManThreshold, { paused: cronPaused });

        // Email & Telegram are TEMPORARILY DISABLED via ENABLE_EMAIL/ENABLE_TELEGRAM vars
        const emailEnabled = String(env.ENABLE_EMAIL || 'false').trim().toLowerCase() === 'true';
        const telegramEnabled = String(env.ENABLE_TELEGRAM || 'false').trim().toLowerCase() === 'true';
        const emailOk = emailEnabled && Boolean(env.RESEND_API_KEY && env.EMAIL_TO);
        const telegramOk = telegramEnabled && Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
        const vapidPublicKey = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;

        const html = renderDashboardHtml({
          state,
          deadMan,
          cronPaused,
          targetUrl: sanitizeHttpUrl(env.TARGET_URL),
          targetProgrammeName: env.TARGET_PROGRAMME_NAME || 'M.A. POLITICAL SCIENCE (Semester-II)',
          targetProgrammeCode: env.TARGET_PROGRAMME_CODE || 'MAPSN-2',
          targetSession: env.TARGET_SESSION || 'JUNE26',
          checkIntervalMinutes,
          emailEnabled,
          telegramEnabled,
          emailOk,
          telegramOk,
          pushSubscriberCount: pushSubs.length,
          vapidPublicKey
        });

        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }

      // 404 Handler
      return new Response(JSON.stringify({
        error: 'Not Found',
        message: `Endpoint ${path} does not exist. Available: /, /sw.js, /health, /status, /check-now, /test-notify, /api/push/*`
      }, null, 2), {
        status: 404,
        headers: corsHeaders
      });

    } catch (err) {
      logger.error(`Unhandled error in fetch handler: ${err.message}`, { stack: err.stack });
      return new Response(JSON.stringify({
        error: 'Internal Server Error',
        message: err.message
      }, null, 2), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

/**
 * Render Modern HTML Monitoring Dashboard
 */
export function renderDashboardHtml({
  state,
  deadMan,
  cronPaused = false,
  targetUrl = 'https://online.vmou.ac.in/results.aspx',
  targetProgrammeName = 'M.A. POLITICAL SCIENCE (Semester-II)',
  targetProgrammeCode = 'MAPSN-2',
  targetSession = 'JUNE26',
  checkIntervalMinutes = 5,
  emailEnabled = false,
  telegramEnabled = false,
  emailOk = false,
  telegramOk = false,
  pushSubscriberCount = 0,
  vapidPublicKey = ''
}) {
  const safePortalUrl = sanitizeHttpUrl(targetUrl);
  const thresholdMin = deadMan?.thresholdMinutes ?? 10;
  const serverTimeIST = formatIST(new Date());

  let statusBadge;
  if (cronPaused) {
    statusBadge = `<span style="background: #b45309; color: #fef3c7; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">⏸ PAUSED</span>`;
  } else if (state.lastCheckStatus === 'error' || deadMan.tripped) {
    statusBadge = `<span style="background: #ef4444; color: #fff; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">● ALERT / DEGRADED</span>`;
  } else if (state.lastCheckStatus === 'never_run') {
    statusBadge = `<span style="background: #334155; color: #cbd5e1; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">○ WAITING FOR CHECK</span>`;
  } else {
    statusBadge = `<span style="background: #10b981; color: #fff; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">● OPERATIONAL</span>`;
  }

  let deadManColor = '#34d399';
  let deadManLabel = '✓ Operational';
  let deadManSubtext = `Elapsed: ${deadMan.elapsedMinutes} mins (Threshold: ${thresholdMin}m)`;

  if (cronPaused) {
    deadManColor = '#fbbf24';
    deadManLabel = '⏸ Paused';
    deadManSubtext = `Cron disabled (Threshold: ${thresholdMin}m)`;
  } else if (deadMan.tripped) {
    deadManColor = '#f87171';
    deadManLabel = `⚠️ TRIPPED (> ${thresholdMin}m)`;
  } else if (state.lastCheckStatus === 'never_run') {
    deadManColor = '#94a3b8';
    deadManLabel = '○ Pending First Run';
    deadManSubtext = `Threshold: ${thresholdMin}m`;
  }

  const lastErrorNotice = state.lastError
    ? `<div class="error-banner">
        <strong>Last Check Error:</strong>
        <span class="selectable" data-copyable="true">${escapeHtml(state.lastError)}</span>
      </div>`
    : '';

  const emptyResultsText = cronPaused
    ? 'No target programme results detected yet. Scheduled monitoring is paused — use Manual Check below to poll on demand.'
    : `No target programme results detected yet. Monitoring every ${checkIntervalMinutes} minute${checkIntervalMinutes === 1 ? '' : 's'}...`;

  const resultsList = (state.detectedResults || []).length > 0
    ? state.detectedResults.map(r => `
      <div class="result-item">
        <div class="result-title">
          <span aria-hidden="true">🎉</span>
          <strong class="selectable" data-copyable="true">${escapeHtml(r.courseName)}</strong>
        </div>
        <div class="result-meta">
          <span>📅 Declared: <strong class="selectable" data-copyable="true">${escapeHtml(r.declaredDate || 'N/A')}</strong></span>
          <span>|</span>
          <span>📂 Category: <span class="selectable" data-copyable="true">${escapeHtml(r.category || 'N/A')}</span></span>
          ${r.courseCode ? `<span>|</span><span>🏷️ Code: <span class="selectable" data-copyable="true">${escapeHtml(r.courseCode)}</span></span>` : ''}
        </div>
      </div>
    `).join('')
    : `<div class="empty-results">${escapeHtml(emptyResultsText)}</div>`;

  const lastCheckValueHtml = state.lastCheckTimestampIST
    ? `<span class="selectable" data-copyable="true">${escapeHtml(state.lastCheckTimestampIST)}</span>`
    : `<span>Never Run</span>`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VMOU Result Monitor | Cloudflare Worker</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="alternate icon" type="image/svg+xml" href="data:image/svg+xml;utf8,${encodeURIComponent(FAVICON_SVG)}">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --success: #34d399;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    html, body {
      user-select: none;
      -webkit-user-select: none;
      -moz-user-select: none;
      -ms-user-select: none;
      -webkit-touch-callout: none;
    }
    body {
      margin: 0;
      padding: 24px;
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
    /* Only explicitly copyable data elements are selectable */
    .selectable, .selectable * {
      user-select: text;
      -webkit-user-select: text;
      -moz-user-select: text;
      -ms-user-select: text;
      -webkit-touch-callout: default;
      cursor: text;
    }
    a.selectable {
      cursor: pointer;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .card-value {
      font-size: 20px;
      font-weight: 700;
      color: #fff;
    }
    .channel-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      margin-right: 6px;
      margin-bottom: 6px;
    }
    .badge-on { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #451a03; color: #fdba74; }
    .result-item {
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(52, 211, 153, 0.35);
      padding: 14px 16px;
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .result-item:last-child {
      margin-bottom: 0;
    }
    .result-title {
      color: #6ee7b7;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .result-meta {
      font-size: 13px;
      color: #cbd5e1;
      margin-top: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .empty-results {
      color: var(--text-muted);
      font-style: italic;
      padding: 16px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px dashed var(--border);
      border-radius: 8px;
      text-align: center;
      font-size: 14px;
    }
    .error-banner {
      margin-bottom: 20px;
      padding: 12px 16px;
      border-radius: 8px;
      background: rgba(127, 29, 29, 0.45);
      border: 1px solid rgba(248, 113, 113, 0.4);
      color: #fecaca;
      font-size: 13px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .btn {
      display: inline-block;
      background: #0284c7;
      color: #fff;
      padding: 10px 20px;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: background 0.2s, opacity 0.2s;
    }
    .btn:hover:not(:disabled) { background: #0369a1; }
    .btn:disabled { opacity: 0.65; cursor: not-allowed; }
    .btn-secondary {
      background: #334155;
      color: #e2e8f0;
    }
    .btn-secondary:hover:not(:disabled) { background: #475569; }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 16px;
      flex-wrap: wrap;
    }
    footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
    }
    @media (max-width: 600px) {
      body { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: flex; align-items: center; gap: 14px;">
        <div style="width: 44px; height: 44px; flex-shrink: 0; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);">
          ${FAVICON_SVG}
        </div>
        <div>
          <h1>VMOU Result Monitor</h1>
          <div style="font-size: 14px; color: var(--text-muted); margin-top: 2px;">
            Vardhman Mahaveer Open University, Kota &middot; Autonomous Edge Monitoring
          </div>
        </div>
      </div>
      <div>${statusBadge}</div>
    </div>

    ${lastErrorNotice}

    <div class="grid">
      <div class="card">
        <div class="card-title">Last Check Time</div>
        <div class="card-value" style="font-size: 16px;">
          ${lastCheckValueHtml}
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
          Duration: ${state.lastDurationMs || 0}ms | Total Runs: ${state.totalChecks || 0}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Dead Man's Switch</div>
        <div class="card-value" style="font-size: 16px; color: ${deadManColor};">
          ${deadManLabel}
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
          ${escapeHtml(deadManSubtext)}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Target Programmes Monitored</div>
        <div class="card-value" style="font-size: 15px;">
          <span class="selectable" data-copyable="true">${escapeHtml(targetProgrammeName)}</span>
          <div style="font-size: 13px; color: var(--text-muted); font-weight: 500; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 12px;">
            <span style="white-space: nowrap;">Programme Code: <span class="selectable" data-copyable="true" style="color: #e2e8f0; font-weight: 600;">${escapeHtml(targetProgrammeCode)}</span></span>
            <span style="white-space: nowrap;">Session: <span class="selectable" data-copyable="true" style="color: #e2e8f0; font-weight: 600;">${escapeHtml(targetSession)}</span></span>
          </div>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
          ${cronPaused ? 'Schedule: Paused (CRON_PAUSED=true)' : `Interval: Every ${checkIntervalMinutes} minute${checkIntervalMinutes === 1 ? '' : 's'} (Cron Trigger)`}
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <div class="card-title">Notification Channels Configured</div>
      <div style="margin-top: 10px;">
        <span class="channel-badge ${emailOk ? 'badge-on' : 'badge-off'}">
          ${emailOk ? '✓' : '&#10007;'} Resend Email${emailEnabled ? '' : ' (disabled)'}
        </span>
        <span class="channel-badge ${telegramOk ? 'badge-on' : 'badge-off'}">
          ${telegramOk ? '✓' : '&#10007;'} Telegram Bot${telegramEnabled ? '' : ' (disabled)'}
        </span>
        <span id="channel-push-badge" class="channel-badge badge-on">
          ✓ Browser Web Push (${pushSubscriberCount} device${pushSubscriberCount === 1 ? '' : 's'})
        </span>
      </div>
    </div>

    <!-- Browser Web Push Notification Control Card -->
    <div class="card" style="margin-bottom: 24px; border: 1px solid #0284c7; background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div>
          <div class="card-title" style="color: #38bdf8;">🔔 Browser Push Notifications</div>
          <div style="font-size: 17px; font-weight: 700; color: #fff; margin-top: 2px;">
            Instant Device Alerts (Web Push)
          </div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 6px; max-width: 650px;">
            Turn on notification permission to receive instant popups on this phone or PC the moment VMOU declares your result — even when this website is closed.
          </div>
        </div>
        <div id="push-status-pill">
          <span style="background: #334155; color: #94a3b8; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 12px;">
            Checking status...
          </span>
        </div>
      </div>

      <div style="margin-top: 18px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
        <button id="btn-subscribe-push" type="button" class="btn" style="background: #0284c7;" onclick="handlePushSubscribeClick()">
          🔔 Turn on Push Notifications
        </button>
        <button id="btn-test-push" type="button" class="btn btn-secondary" style="display: none;" onclick="handleSendTestPush()">
          🧪 Send Test Push to this Device
        </button>
        <button id="btn-unsubscribe-push" type="button" class="btn btn-secondary" style="display: none; font-size: 12px; padding: 6px 12px; background: transparent; border: 1px solid #475569;" onclick="handlePushUnsubscribeClick()">
          Disable on this Device
        </button>
      </div>

      <div id="push-msg" class="selectable" data-copyable="true" style="margin-top: 12px; font-size: 13px; display: none;"></div>

      <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid #334155; font-size: 12px; color: #64748b; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span>Active Subscribed Devices: <strong id="sub-count-display" style="color: #94a3b8;">${pushSubscriberCount}</strong></span>
        <span>Works on Chrome, Android, Edge, Safari (macOS/iOS), Firefox</span>
      </div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <div class="card-title" style="margin-bottom: 14px;">Detected Results Status</div>
      ${resultsList}
    </div>

    <div class="card">
      <div class="card-title">Quick Actions &amp; Diagnostic Tools</div>
      <div class="actions">
        <button id="btn-manual-check" type="button" class="btn" onclick="handleManualCheck()">⚡ Run Manual Check Now</button>
        <button id="btn-test-all" type="button" class="btn btn-secondary" onclick="handleTestAllChannels()">🧪 Test All Notification Channels</button>
        <a class="btn btn-secondary" href="/status" target="_blank" rel="noopener noreferrer">📊 Raw JSON Telemetry</a>
      </div>
      <div id="action-feedback" class="selectable" data-copyable="true" style="display: none; margin-top: 14px; padding: 12px 16px; border-radius: 8px; font-size: 13px;"></div>
    </div>

    <footer>
      Running on Cloudflare Global Edge Network &bull; Server Time: <span class="selectable" data-copyable="true">${escapeHtml(serverTimeIST)}</span>
      <br>Target Portal: <a class="selectable" data-copyable="true" href="${escapeHtml(safePortalUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--primary);">${escapeHtml(safePortalUrl)}</a>
    </footer>
  </div>

  <script>
    const VAPID_PUBLIC_KEY = '${escapeHtml(vapidPublicKey)}';

    function isCopyableTarget(target) {
      const el = target && target.nodeType === 3 ? target.parentElement : target;
      return Boolean(el && typeof el.closest === 'function' && el.closest('.selectable, input, textarea'));
    }

    // Prevent starting text selection outside explicitly copyable elements
    document.addEventListener('selectstart', (e) => {
      if (!isCopyableTarget(e.target)) {
        e.preventDefault();
      }
    });

    // Disable right-click / long-press context menu on mobile devices for non-copyable UI,
    // while keeping copyable elements selectable and copyable via long-press.
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
    if (isMobile) {
      document.addEventListener('contextmenu', (e) => {
        if (!isCopyableTarget(e.target)) {
          e.preventDefault();
        }
      });
    }

    function updateSubscriberCountUI(count) {
      if (typeof count !== 'number' || Number.isNaN(count)) return;
      const countEl = document.getElementById('sub-count-display');
      if (countEl) {
        countEl.innerText = String(count);
      }
      const badgeEl = document.getElementById('channel-push-badge');
      if (badgeEl) {
        badgeEl.innerText = '✓ Browser Web Push (' + count + ' device' + (count === 1 ? '' : 's') + ')';
      }
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      return outputArray;
    }

    async function checkPushStatus() {
      const pill = document.getElementById('push-status-pill');
      const btnSubscribe = document.getElementById('btn-subscribe-push');
      const btnTest = document.getElementById('btn-test-push');
      const btnUnsub = document.getElementById('btn-unsubscribe-push');
      const msg = document.getElementById('push-msg');

      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (pill) pill.innerHTML = '<span style="background: #451a03; color: #fdba74; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 12px;">Push Not Supported</span>';
        if (btnSubscribe) {
          btnSubscribe.disabled = true;
          btnSubscribe.innerText = 'Push Not Supported in this Browser';
        }
        return;
      }

      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();

        if (Notification.permission === 'denied') {
          if (pill) pill.innerHTML = '<span style="background: #450a0a; color: #fca5a5; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 12px;">🚫 Blocked in Browser</span>';
          if (btnSubscribe) {
            btnSubscribe.style.display = 'inline-block';
            btnSubscribe.disabled = true;
            btnSubscribe.innerText = 'Notifications Blocked in Settings';
          }
          if (msg) {
            msg.style.display = 'block';
            msg.style.color = '#f87171';
            msg.innerText = 'Notifications are currently blocked in your browser site permissions. Please allow notifications in your browser address bar to receive alerts.';
          }
          if (btnTest) btnTest.style.display = 'none';
          if (btnUnsub) btnUnsub.style.display = 'none';
          return;
        }

        if (sub) {
          if (pill) pill.innerHTML = '<span style="background: #065f46; color: #6ee7b7; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 12px;">✓ Push Alerts Active</span>';
          if (btnSubscribe) btnSubscribe.style.display = 'none';
          if (btnTest) btnTest.style.display = 'inline-block';
          if (btnUnsub) btnUnsub.style.display = 'inline-block';
        } else {
          if (pill) pill.innerHTML = '<span style="background: #334155; color: #94a3b8; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 12px;">○ Not Enabled</span>';
          if (btnSubscribe) {
            btnSubscribe.style.display = 'inline-block';
            btnSubscribe.disabled = false;
            btnSubscribe.innerText = '🔔 Turn on Push Notifications';
          }
          if (btnTest) btnTest.style.display = 'none';
          if (btnUnsub) btnUnsub.style.display = 'none';
        }
      } catch (err) {
        console.error('Error checking push status:', err);
        if (pill) pill.innerHTML = '<span style="background: #451a03; color: #fdba74; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 12px;">⚠️ Unavailable</span>';
        if (btnSubscribe) {
          btnSubscribe.disabled = false;
          btnSubscribe.innerText = '🔔 Turn on Push Notifications';
        }
      }
    }

    async function handlePushSubscribeClick() {
      const btnSubscribe = document.getElementById('btn-subscribe-push');
      const msg = document.getElementById('push-msg');
      btnSubscribe.disabled = true;
      btnSubscribe.innerText = 'Requesting permission...';
      if (msg) msg.style.display = 'none';

      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          btnSubscribe.disabled = false;
          btnSubscribe.innerText = '🔔 Turn on Push Notifications';
          if (msg) {
            msg.style.display = 'block';
            msg.style.color = '#fca5a5';
            msg.innerText = 'Notification permission was not granted (' + perm + '). Click again or check browser settings.';
          }
          await checkPushStatus();
          return;
        }

        btnSubscribe.innerText = 'Subscribing device...';
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const appServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: appServerKey
          });
        }

        const serializedSub = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
        const res = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: serializedSub })
        });

        const data = await res.json();
        if (res.ok) {
          if (msg) {
            msg.style.display = 'block';
            msg.style.color = '#34d399';
            msg.innerText = '🎉 Device successfully subscribed! You will receive instant notifications when results are declared.';
          }
          updateSubscriberCountUI(data.totalSubscribers);
        } else {
          throw new Error(data.error || 'Server rejected subscription');
        }

        await checkPushStatus();
      } catch (err) {
        btnSubscribe.disabled = false;
        btnSubscribe.innerText = '🔔 Turn on Push Notifications';
        if (msg) {
          msg.style.display = 'block';
          msg.style.color = '#f87171';
          msg.innerText = 'Failed to enable notifications: ' + err.message;
        }
        console.error(err);
      }
    }

    async function handlePushUnsubscribeClick() {
      const btnUnsub = document.getElementById('btn-unsubscribe-push');
      const msg = document.getElementById('push-msg');
      if (btnUnsub) {
        btnUnsub.disabled = true;
        btnUnsub.innerText = 'Disabling...';
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const res = await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.error || 'Failed to remove subscription from server');
          }
          await sub.unsubscribe();
          updateSubscriberCountUI(data.remainingSubscribers);
        }
        if (msg) {
          msg.style.display = 'block';
          msg.style.color = '#94a3b8';
          msg.innerText = 'Push notifications disabled on this device.';
        }
        await checkPushStatus();
      } catch (err) {
        console.error(err);
        if (msg) {
          msg.style.display = 'block';
          msg.style.color = '#f87171';
          msg.innerText = 'Failed to disable notifications: ' + err.message;
        }
      } finally {
        if (btnUnsub) {
          btnUnsub.disabled = false;
          btnUnsub.innerText = 'Disable on this Device';
        }
      }
    }

    async function handleSendTestPush() {
      const btnTest = document.getElementById('btn-test-push');
      const msg = document.getElementById('push-msg');
      btnTest.disabled = true;
      btnTest.innerText = 'Sending test push...';
      try {
        const res = await fetch('/api/push/test', { method: 'POST' });
        const data = await res.json();
        if (msg) {
          msg.style.display = 'block';
          if (res.ok && data.report?.delivered > 0) {
            msg.style.color = '#34d399';
            msg.innerText = '✅ Test notification sent! Check your device notification tray.';
          } else if (!res.ok) {
            msg.style.color = '#f87171';
            msg.innerText = '✗ ' + (data.message || data.error || 'Failed to send test push.');
          } else {
            msg.style.color = '#38bdf8';
            msg.innerText = data.message || 'Test triggered.';
          }
        }
      } catch (err) {
        if (msg) {
          msg.style.display = 'block';
          msg.style.color = '#f87171';
          msg.innerText = 'Error sending test push: ' + err.message;
        }
      } finally {
        btnTest.disabled = false;
        btnTest.innerText = '🧪 Send Test Push to this Device';
      }
    }

    async function handleManualCheck() {
      const btn = document.getElementById('btn-manual-check');
      const fb = document.getElementById('action-feedback');
      const originalText = btn.innerText;
      btn.disabled = true;
      btn.innerText = '⏳ Checking VMOU portal...';
      if (fb) fb.style.display = 'none';

      try {
        const res = await fetch('/check-now', { method: 'POST' });
        const data = await res.json();
        if (fb) {
          fb.style.display = 'block';
          if (res.ok) {
            fb.style.background = '#065f46';
            fb.style.color = '#a7f3d0';
            fb.innerText = '✓ Check completed (' + (data.durationMs || 0) + 'ms). Total declared: ' + (data.totalDeclaredOnPage || 0) + '. Matches: ' + (data.matches ? data.matches.length : 0);
            setTimeout(() => location.reload(), 2000);
          } else {
            fb.style.background = '#450a0a';
            fb.style.color = '#fca5a5';
            fb.innerText = '✗ Check failed: ' + (data.error || data.message || 'Unknown error');
          }
        }
      } catch (err) {
        if (fb) {
          fb.style.display = 'block';
          fb.style.background = '#450a0a';
          fb.style.color = '#fca5a5';
          fb.innerText = '✗ Network error: ' + err.message;
        }
      } finally {
        btn.disabled = false;
        btn.innerText = originalText;
      }
    }

    async function handleTestAllChannels() {
      const btn = document.getElementById('btn-test-all');
      const fb = document.getElementById('action-feedback');
      const originalText = btn.innerText;
      btn.disabled = true;
      btn.innerText = '⏳ Dispatching test alerts...';
      if (fb) fb.style.display = 'none';

      const channelLabels = {
        email: 'Email',
        telegram: 'Telegram',
        webpush: 'Browser Web Push'
      };

      try {
        const res = await fetch('/test-notify', { method: 'POST' });
        const data = await res.json();
        if (fb) {
          fb.style.display = 'block';
          if (res.ok) {
            fb.style.background = '#065f46';
            fb.style.color = '#a7f3d0';
            const channels = (data.report?.successfulChannels && data.report.successfulChannels.length)
              ? data.report.successfulChannels.map((c) => channelLabels[c] || c).join(', ')
              : 'configured channels';
            fb.innerText = '✓ Test notification sent successfully to: ' + channels + '!';
          } else if (res.status === 429) {
            fb.style.background = '#451a03';
            fb.style.color = '#fdba74';
            fb.innerText = '⏳ ' + data.message;
          } else {
            fb.style.background = '#450a0a';
            fb.style.color = '#fca5a5';
            fb.innerText = '✗ ' + (data.message || data.error || 'Failed to dispatch test notification');
          }
        }
      } catch (err) {
        if (fb) {
          fb.style.display = 'block';
          fb.style.background = '#450a0a';
          fb.style.color = '#fca5a5';
          fb.innerText = '✗ Network error: ' + err.message;
        }
      } finally {
        btn.disabled = false;
        btn.innerText = originalText;
      }
    }

    window.addEventListener('DOMContentLoaded', checkPushStatus);
  </script>
</body>
</html>
  `.trim();
}
