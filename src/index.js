/**
 * ==============================================================================
 * VMOU Result Notifier - Main Cloudflare Worker Entry Point
 * ==============================================================================
 * Architecture:
 * 1. Scheduled Event Handler (scheduled):
 *    - Triggered every 5 minutes by Cloudflare's Cron Triggers
 *    - Executes check with automatic retry (max 3 attempts)
 *    - Persists execution state & timestamps to Cloudflare KV
 *    - Evaluates Dead Man's Switch (alerts if gap > 10 minutes)
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
 *    - POST|GET /check-now              -> On-demand manual check trigger
 *    - POST|GET /test-notify            -> Test all notification channels with mock data
 * ==============================================================================
 */

import {
  logger,
  getNowIso,
  formatIST,
  escapeHtml,
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
    icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="%23134a5c"/><text x="50" y="65" font-size="50" text-anchor="middle" fill="%23ffffff">🎓</text></svg>',
    badge: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="%23134a5c"/><text x="50" y="65" font-size="50" text-anchor="middle" fill="%23ffffff">🎓</text></svg>',
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

  let targetUrl = 'https://online.vmou.ac.in/results.aspx';
  if (event.action === 'open_dashboard') {
    targetUrl = 'https://result-notifier.nvy.workers.dev/';
  } else if (event.notification.data && event.notification.data.url) {
    targetUrl = event.notification.data.url;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && client.url.includes('result-notifier') && 'focus' in client) {
          return client.focus();
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
 * Execute a check run, evaluate state, and dispatch notifications if new results are declared.
 *
 * @param {Object} env Cloudflare Worker environment bindings
 * @param {Object} options Configuration flags
 * @param {boolean} options.forceNotification Force sending alerts even if already notified
 * @param {string} options.triggerSource "cron" | "manual"
 * @returns {Promise<Object>} Execution result summary
 */
async function runCheckPipeline(env, { triggerSource = 'cron' } = {}) {
  const runStartMs = Date.now();
  const kv = env.RESULTS_KV || null;
  const maxRetries = parseInt(env.MAX_RETRIES || '3', 10);
  const deadManThreshold = parseInt(env.DEAD_MAN_THRESHOLD_MINUTES || '10', 10);

  logger.info(`=== Starting check iteration [Trigger: ${triggerSource}] ===`);

  // 1. Evaluate Dead Man's Switch from previous state
  const previousState = await getState(kv);
  const deadManStatus = evaluateDeadManSwitch(previousState, deadManThreshold);

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
    const shouldAlert = shouldDispatchNotification(currentState, checkResult.matches);

    if (shouldAlert) {
      // Cooldown guard: prevent sending duplicate bursts (5 min minimum between alerts)
      const cooldownMinutes = 5;
      const cooldown = checkNotificationCooldown(currentState, cooldownMinutes);

      if (cooldown.inCooldown) {
        logger.warn(`⏳ [NOTIFICATION COOLDOWN] Alert suppressed: Sent ${cooldown.elapsedSeconds}s ago (Cooldown: ${cooldownMinutes * 60}s). Skipping duplicate.`);
      } else {
        // Concurrency lock: ensures only ONE worker instance across all Cloudflare PoPs dispatches the notification
        const lockAcquired = await acquireDispatchLock(kv, 60);

        if (!lockAcquired) {
          logger.warn(`🔒 [CONCURRENCY LOCK] Another worker instance is currently dispatching notifications. Skipping duplicate broadcast.`);
        } else {
          try {
            logger.info(`🔔 New target exam results detected! Initiating multi-channel broadcast...`);

            // Mark in-flight in KV state BEFORE external API calls to immediately block any racing instances
            await recordNotificationDispatched(kv, checkResult.matches, { status: 'in_progress', timestamp: getNowIso() });

            // Broadcast alerts once across channels
            notificationReport = await notifyAllChannels(env, checkResult);

            // Record completed report
            await recordNotificationDispatched(kv, checkResult.matches, notificationReport);
          } finally {
            await releaseDispatchLock(kv);
          }
        }
      }
    } else {
      logger.info(`ℹ️ Target results are active on portal, but alert was previously dispatched. Skipping duplicate notification.`);
    }
  } else {
    logger.info(`Checked ${checkResult.totalDeclaredOnPage} declared results. No target programme (M.A. Political Science Sem-II / MAPSN-2) detected yet.`);
  }

  const totalDurationMs = Date.now() - runStartMs;

  return {
    success: true,
    triggerSource,
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
        const deadManThreshold = parseInt(env.DEAD_MAN_THRESHOLD_MINUTES || '10', 10);
        const deadMan = evaluateDeadManSwitch(state, deadManThreshold);

        const isHealthy = state.lastCheckStatus !== 'error' && !deadMan.tripped;

        const body = {
          status: isHealthy ? 'healthy' : (deadMan.tripped ? 'degraded_dead_man' : 'unhealthy'),
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
          status: isHealthy ? 200 : 503,
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
        if (!payload || !payload.subscription || !payload.subscription.endpoint) {
          return new Response(JSON.stringify({ error: 'Invalid push subscription payload' }), {
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
        if (!payload || !payload.endpoint) {
          return new Response(JSON.stringify({ error: 'Missing subscription endpoint' }), {
            status: 400,
            headers: corsHeaders
          });
        }
        const unsubResult = await removePushSubscription(kv, payload.endpoint);
        return new Response(JSON.stringify({
          success: true,
          message: 'Device unsubscribed from browser push notifications',
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
        const mockCheckResult = {
          portalUrl: env.TARGET_URL || 'https://online.vmou.ac.in/results.aspx',
          checkTimestamp: getNowIso(),
          checkTimestampIST: formatIST(new Date()),
          matches: [
            {
              targetDefinitionId: 'MA_POLITICAL_SCIENCE_SEM2',
              targetKey: 'M.A. POLITICAL SCIENCE (Semester-II)',
              courseName: 'M.A. POLITICAL SCIENCE (Semester-II) Examination Result (TEST ALERT)',
              declaredDate: new Date().toLocaleDateString('en-GB'),
              category: 'Exam Session JUNE26'
            }
          ]
        };

        const pushReport = await sendWebPush(env, mockCheckResult);

        return new Response(JSON.stringify({
          message: pushReport.delivered > 0
            ? 'Test push notification delivered to active devices!'
            : (pushReport.subscribers === 0
                ? 'No active browser subscriptions registered yet. Click "Turn on Push Notifications" on the dashboard first!'
                : 'Test push attempt completed.'),
          report: pushReport
        }, null, 2), {
          status: pushReport.success ? 200 : 500,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // GET /status - Detailed telemetry & error history
      // ------------------------------------------------------------------------
      if (path === '/status') {
        const state = await getState(kv);
        const pushSubs = await getPushSubscriptions(kv);
        const deadManThreshold = parseInt(env.DEAD_MAN_THRESHOLD_MINUTES || '10', 10);
        const deadMan = evaluateDeadManSwitch(state, deadManThreshold);

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
            targetUrl: env.TARGET_URL || 'https://online.vmou.ac.in/results.aspx',
            targetSession: env.TARGET_SESSION || 'JUNE26',
            targetProgrammeCode: env.TARGET_PROGRAMME_CODE || 'MAPSN-2',
            targetProgrammeName: env.TARGET_PROGRAMME_NAME || 'M.A. POLITICAL SCIENCE (Semester-II)',
            checkIntervalMinutes: env.CHECK_INTERVAL_MINUTES || '5',
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
        logger.info('Manual check requested via HTTP');

        const result = await runCheckPipeline(env, {
          triggerSource: 'manual_http'
        });

        return new Response(JSON.stringify(result, null, 2), {
          status: result.success ? 200 : 500,
          headers: corsHeaders
        });
      }

      // ------------------------------------------------------------------------
      // POST | GET /test-notify - Test notification channels with mock data
      // Protected by 60s cooldown and distributed lock to prevent multi-message bursts
      // ------------------------------------------------------------------------
      if (path === '/test-notify') {
        logger.info(`Test notification requested via HTTP`);

        const state = await getState(kv);
        // Strict 60s cooldown on test alerts to avoid spamming
        const cooldown = checkNotificationCooldown(state, 1);
        if (cooldown.inCooldown) {
          logger.warn(`Test notification rate-limited: Dispatched ${cooldown.elapsedSeconds}s ago (Cooldown: 60s)`);
          return new Response(JSON.stringify({
            success: false,
            rateLimited: true,
            message: `Rate limited: A notification was already sent ${cooldown.elapsedSeconds}s ago. Please wait ${cooldown.remainingSeconds}s before sending another test alert.`,
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
          const mockCheckResult = {
            portalUrl: env.TARGET_URL || 'https://online.vmou.ac.in/results.aspx',
            checkTimestamp: getNowIso(),
            checkTimestampIST: formatIST(new Date()),
            matches: [
              {
                targetDefinitionId: 'MA_POLITICAL_SCIENCE_SEM2',
                targetKey: 'M.A. POLITICAL SCIENCE (Semester-II)',
                courseName: 'M.A. POLITICAL SCIENCE (Semester-II) Examination Result (TEST ALERT)',
                declaredDate: new Date().toLocaleDateString('en-GB'),
                category: 'Exam Session JUNE26'
              }
            ]
          };

          const notifyReport = await notifyAllChannels(env, mockCheckResult);

          // Record test notification timestamp to track cooldown
          await updateState(kv, {
            lastNotificationTimestamp: getNowIso(),
            lastNotificationTimestampIST: formatIST(new Date()),
            lastNotificationStatus: notifyReport
          });

          const responseMessage = notifyReport.anySucceeded
            ? 'Test notification triggered across all configured channels'
            : (notifyReport.skippedChannels?.length === 3
                ? 'No notification channels dispatched: only Browser Web Push is active (Email & Telegram are disabled by configuration) and no devices are subscribed yet. Enable Browser Push on the dashboard first.'
                : 'Test notification dispatch failed on all channels (see report)');

          return new Response(JSON.stringify({
            success: notifyReport.anySucceeded,
            message: responseMessage,
            report: notifyReport
          }, null, 2), {
            status: notifyReport.anySucceeded ? 200 : 500,
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
        const deadManThreshold = parseInt(env.DEAD_MAN_THRESHOLD_MINUTES || '10', 10);
        const deadMan = evaluateDeadManSwitch(state, deadManThreshold);

        // Email & Telegram are TEMPORARILY DISABLED via ENABLE_EMAIL/ENABLE_TELEGRAM vars
        const emailEnabled = String(env.ENABLE_EMAIL || 'false').trim().toLowerCase() === 'true';
        const telegramEnabled = String(env.ENABLE_TELEGRAM || 'false').trim().toLowerCase() === 'true';
        const emailOk = emailEnabled && Boolean(env.RESEND_API_KEY && env.EMAIL_TO);
        const telegramOk = telegramEnabled && Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
        const vapidPublicKey = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;

        const html = renderDashboardHtml({
          state,
          deadMan,
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
function renderDashboardHtml({ state, deadMan, emailEnabled = false, telegramEnabled = false, emailOk = false, telegramOk = false, pushSubscriberCount = 0, vapidPublicKey = '' }) {
  const isHealthy = state.lastCheckStatus === 'success' && !deadMan.tripped;
  const statusBadge = isHealthy
    ? `<span style="background: #10b981; color: #fff; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">● OPERATIONAL</span>`
    : `<span style="background: #ef4444; color: #fff; padding: 4px 12px; border-radius: 9999px; font-weight: 600; font-size: 13px;">● ALERT / DEGRADED</span>`;

  const resultsList = (state.detectedResults || []).length > 0
    ? state.detectedResults.map(r => `
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 14px; border-radius: 8px; margin-bottom: 10px;">
        <strong style="color: #166534; font-size: 15px;">🎉 ${escapeHtml(r.courseName)}</strong>
        <div style="font-size: 13px; color: #374151; margin-top: 4px;">
          📅 Declared: <strong>${escapeHtml(r.declaredDate || 'N/A')}</strong> | 📂 Category: ${escapeHtml(r.category || 'N/A')}
        </div>
      </div>
    `).join('')
    : `<div style="color: #6b7280; font-style: italic; padding: 16px; background: #f9fafb; border-radius: 8px; text-align: center;">No target programme results detected yet. Monitoring every 5 minutes...</div>`;

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
    body {
      margin: 0;
      padding: 24px;
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
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
      transition: background 0.2s;
    }
    .btn:hover { background: #0369a1; }
    .btn-secondary {
      background: #334155;
      color: #e2e8f0;
    }
    .btn-secondary:hover { background: #475569; }
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

    <div class="grid">
      <div class="card">
        <div class="card-title">Last Check Time</div>
        <div class="card-value" style="font-size: 16px;">
          ${escapeHtml(state.lastCheckTimestampIST || 'Never Run')}
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
          Duration: ${state.lastDurationMs || 0}ms | Total Runs: ${state.totalChecks || 0}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Dead Man's Switch</div>
        <div class="card-value" style="font-size: 16px; color: ${deadMan.tripped ? '#f87171' : '#34d399'};">
          ${deadMan.tripped ? '⚠️ TRIPPED (> 10m)' : '✓ Operational'}
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
          Elapsed: ${deadMan.elapsedMinutes} mins (Threshold: 10m)
        </div>
      </div>

      <div class="card">
        <div class="card-title">Target Programmes Monitored</div>
        <div class="card-value" style="font-size: 15px;">
          M.A. POLITICAL SCIENCE (Semester-II)<br>
          <span style="font-size: 13px; color: var(--text-muted);">Programme Code: MAPSN-2 &middot; Session: JUNE26</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
          Interval: Every 5 minutes (Cron Trigger)
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
        <span class="channel-badge badge-on">
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
        <button id="btn-subscribe-push" class="btn" style="background: #0284c7;" onclick="handlePushSubscribeClick()">
          🔔 Turn on Push Notifications
        </button>
        <button id="btn-test-push" class="btn btn-secondary" style="display: none;" onclick="handleSendTestPush()">
          🧪 Send Test Push to this Device
        </button>
        <button id="btn-unsubscribe-push" class="btn btn-secondary" style="display: none; font-size: 12px; padding: 6px 12px; background: transparent; border: 1px solid #475569;" onclick="handlePushUnsubscribeClick()">
          Disable on this Device
        </button>
      </div>

      <div id="push-msg" style="margin-top: 12px; font-size: 13px; display: none;"></div>

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
      <div class="card-title">Quick Actions & Diagnostic Tools</div>
      <div class="actions">
        <button id="btn-manual-check" class="btn" onclick="handleManualCheck()">⚡ Run Manual Check Now</button>
        <button id="btn-test-all" class="btn btn-secondary" onclick="handleTestAllChannels()">🧪 Test All Notification Channels</button>
        <a class="btn btn-secondary" href="/status" target="_blank">📊 Raw JSON Telemetry</a>
      </div>
      <div id="action-feedback" style="display: none; margin-top: 14px; padding: 12px 16px; border-radius: 8px; font-size: 13px;"></div>
    </div>

    <footer>
      Running on Cloudflare Global Edge Network • Server Time: ${formatIST(new Date())}
      <br>Target Portal: <a href="https://online.vmou.ac.in/results.aspx" target="_blank" style="color: var(--primary);">https://online.vmou.ac.in/results.aspx</a>
    </footer>
  </div>

  <script>
    const VAPID_PUBLIC_KEY = '${escapeHtml(vapidPublicKey)}';

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

      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
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
          checkPushStatus();
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

        const res = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub })
        });

        const data = await res.json();
        if (res.ok) {
          if (msg) {
            msg.style.display = 'block';
            msg.style.color = '#34d399';
            msg.innerText = '🎉 Device successfully subscribed! You will receive instant notifications when results are declared.';
          }
          const countEl = document.getElementById('sub-count-display');
          if (countEl && data.totalSubscribers) {
            countEl.innerText = data.totalSubscribers;
          }
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
      const msg = document.getElementById('push-msg');
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint })
          });
          await sub.unsubscribe();
        }
        if (msg) {
          msg.style.display = 'block';
          msg.style.color = '#94a3b8';
          msg.innerText = 'Push notifications disabled on this device.';
        }
        await checkPushStatus();
      } catch (err) {
        console.error(err);
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
        btnTest.disabled = false;
        btnTest.innerText = '🧪 Send Test Push to this Device';
        if (msg) {
          msg.style.display = 'block';
          if (res.ok && data.report?.delivered > 0) {
            msg.style.color = '#34d399';
            msg.innerText = '✅ Test notification sent! Check your device notification tray.';
          } else {
            msg.style.color = '#38bdf8';
            msg.innerText = data.message || 'Test triggered.';
          }
        }
      } catch (err) {
        btnTest.disabled = false;
        btnTest.innerText = '🧪 Send Test Push to this Device';
        if (msg) {
          msg.style.display = 'block';
          msg.style.color = '#f87171';
          msg.innerText = 'Error sending test push: ' + err.message;
        }
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

      try {
        const res = await fetch('/test-notify', { method: 'POST' });
        const data = await res.json();
        if (fb) {
          fb.style.display = 'block';
          if (res.ok) {
            fb.style.background = '#065f46';
            fb.style.color = '#a7f3d0';
            const channels = (data.report?.successfulChannels && data.report.successfulChannels.length)
              ? data.report.successfulChannels.join(', ')
              : 'configured channels';
            fb.innerText = '✓ Test notification sent successfully to: ' + channels + '! Check your Telegram, Email, and Browser.';
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
