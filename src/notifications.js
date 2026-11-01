/**
 * ==============================================================================
 * VMOU Result Notifier - Multi-Channel Notification Engine
 * ==============================================================================
 * Dispatches notifications across 3 independent channels:
 * 1. Resend API (Transactional HTML Email)     -- DISABLED (ENABLE_EMAIL=false)
 * 2. Telegram Bot API (Direct Message & Channel Broadcast with Inline Buttons) -- DISABLED (ENABLE_TELEGRAM=false)
 * 3. Browser Web Push API (RFC 8291 Native Browser Push for Desktop & Mobile)  -- ACTIVE
 *
 * Email & Telegram are temporarily disabled while Web Push is the only channel.
 * Each disabled channel self-skips with `skipped: true, disabled: true`, so
 * re-enabling only requires setting the ENABLE_* env var to "true".
 * Each channel is completely isolated: a failure in one service does not impede
 * the remaining channels.
 * ==============================================================================
 */

import { sendPushBatch } from '@mmmike/web-push';
import {
  logger,
  formatIST,
  escapeHtml,
  getPushSubscriptions,
  prunePushSubscriptions,
  DEFAULT_VAPID_PUBLIC_KEY,
  DEFAULT_VAPID_PRIVATE_KEY,
  DEFAULT_VAPID_SUBJECT
} from './utils.js';

/**
 * Channel enablement flags (configurable via env vars in wrangler.toml).
 * Default is DISABLED ('false') until explicitly re-enabled.
 */
function isEmailEnabled(env = {}) {
  return String(env.ENABLE_EMAIL ?? 'false').trim().toLowerCase() === 'true';
}

function isTelegramEnabled(env = {}) {
  return String(env.ENABLE_TELEGRAM ?? 'false').trim().toLowerCase() === 'true';
}

/**
 * ------------------------------------------------------------------------------
 * 1. EMAIL NOTIFICATION (Resend API)
 * ------------------------------------------------------------------------------
 * Free tier: 100 emails/day, 3,000 emails/month
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */
export async function sendEmail(env, { matches = [], portalUrl, checkTimestampIST, checkTimestampISO }) {
  // TEMPORARILY DISABLED: email channel is switched off via ENABLE_EMAIL=false
  if (!isEmailEnabled(env)) {
    logger.warn('[Resend Email] Skipped: Email channel is disabled by configuration (ENABLE_EMAIL=false).');
    return {
      channel: 'email',
      success: false,
      skipped: true,
      disabled: true,
      error: 'Email channel disabled by configuration (ENABLE_EMAIL=false)'
    };
  }

  const apiKey = env.RESEND_API_KEY;
  const toEmail = env.EMAIL_TO;
  const fromEmail = env.EMAIL_FROM || 'VMOU Exam Alert <onboarding@resend.dev>';

  if (!apiKey || !toEmail) {
    logger.warn('[Resend Email] Skipped: RESEND_API_KEY or EMAIL_TO is not configured.');
    return {
      channel: 'email',
      success: false,
      skipped: true,
      error: 'Missing RESEND_API_KEY or EMAIL_TO secret'
    };
  }

  const courseTitles = matches.map(m => m.courseName).join(', ');
  const subject = `🎓 VMOU Results Declared: ${matches.map(m => m.targetKey || m.courseName).slice(0, 2).join(' & ')}`;

  // Construct Cards for Each Detected Course
  const coursesHtml = matches.map(m => `
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-left: 4px solid #134a5c; border-radius: 8px; padding: 16px; margin-bottom: 14px;">
      <div style="font-size: 16px; font-weight: bold; color: #0f172a; margin-bottom: 6px;">
        ${escapeHtml(m.courseName)}
      </div>
      <div style="font-size: 13px; color: #475569; margin-bottom: 4px;">
        <strong>Category:</strong> ${escapeHtml(m.category || 'Declared Results')}
      </div>
      <div style="font-size: 13px; color: #166534; font-weight: 600;">
        <strong>Status:</strong> Declared on ${escapeHtml(m.declaredDate || 'Today')}
      </div>
    </div>
  `).join('');

  const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #334155;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f1f5f9; padding: 24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);" cellpadding="0" cellspacing="0">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #134a5c 0%, #1e3a8a 100%); padding: 32px 24px; text-align: center;">
              <div style="color: #93c5fd; font-size: 12px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px;">
                VARDHMAN MAHAVEER OPEN UNIVERSITY, KOTA
              </div>
              <h1 style="color: #ffffff; font-size: 24px; font-weight: 800; margin: 0; line-height: 1.3;">
                🎓 Exam Results Declared!
              </h1>
              <p style="color: #e2e8f0; font-size: 14px; margin: 8px 0 0 0;">
                Target programmes detected on the VMOU Online Result Portal
              </p>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 28px 24px;">
              <div style="background-color: #dcfce7; border: 1px solid #86efac; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; display: flex; align-items: center;">
                <span style="font-size: 20px; margin-right: 12px;">✅</span>
                <span style="color: #14532d; font-size: 14px; font-weight: 600;">
                  ${matches.length} target course result${matches.length > 1 ? 's have' : ' has'} been published.
                </span>
              </div>

              <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
                Detected Results:
              </h2>

              ${coursesHtml}

              <!-- Call to Action Button -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 28px; margin-bottom: 24px;">
                <tr>
                  <td align="center">
                    <a href="${portalUrl}" target="_blank" style="display: inline-block; background-color: #134a5c; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; box-shadow: 0 4px 6px rgba(19, 74, 92, 0.3);">
                      🔗 Check Results on VMOU Portal &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Metadata Box -->
              <div style="border-top: 1px solid #e2e8f0; padding-top: 20px; margin-top: 24px; font-size: 12px; color: #64748b; line-height: 1.6;">
                <div><strong>Detection Timestamp:</strong> ${checkTimestampIST || formatIST(new Date())}</div>
                <div><strong>UTC Timestamp:</strong> ${checkTimestampISO || new Date().toISOString()}</div>
                <div><strong>Target Portal:</strong> <a href="${portalUrl}" style="color: #134a5c;">${portalUrl}</a></div>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 16px 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
              Autonomous 24/7 Monitoring powered by <strong>Cloudflare Workers Edge Network</strong>.
              <br>Running with seconds-level precision checks every 5 minutes.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  try {
    logger.info(`[Resend Email] Dispatching alert to ${toEmail}...`);

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject,
        html: htmlBody
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data.message || `HTTP ${response.status} ${response.statusText}`;
      logger.error(`[Resend Email] Failed to send email: ${errMsg}`, data);
      return {
        channel: 'email',
        success: false,
        statusCode: response.status,
        error: errMsg
      };
    }

    logger.info(`[Resend Email] Email sent successfully! Message ID: ${data.id}`);
    return {
      channel: 'email',
      success: true,
      messageId: data.id
    };
  } catch (err) {
    logger.error(`[Resend Email] Network or execution error: ${err.message}`);
    return {
      channel: 'email',
      success: false,
      error: err.message
    };
  }
}

/**
 * ------------------------------------------------------------------------------
 * 2. TELEGRAM BOT NOTIFICATION (Telegram Bot API)
 * ------------------------------------------------------------------------------
 * Free, unlimited, supports inline buttons & channel broadcasts.
 * Docs: https://core.telegram.org/bots/api#sendmessage
 */
export async function sendTelegram(env, { matches = [], portalUrl, checkTimestampIST }) {
  // TEMPORARILY DISABLED: telegram channel is switched off via ENABLE_TELEGRAM=false
  if (!isTelegramEnabled(env)) {
    logger.warn('[Telegram Bot] Skipped: Telegram channel is disabled by configuration (ENABLE_TELEGRAM=false).');
    return {
      channel: 'telegram',
      success: false,
      skipped: true,
      disabled: true,
      error: 'Telegram channel disabled by configuration (ENABLE_TELEGRAM=false)'
    };
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    logger.warn('[Telegram Bot] Skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.');
    return {
      channel: 'telegram',
      success: false,
      skipped: true,
      error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secret'
    };
  }

  // Build HTML formatted message
  const courseItems = matches.map(m =>
    `📌 <b>${escapeHtml(m.courseName)}</b>\n   🗓️ <i>Declared on: ${escapeHtml(m.declaredDate || 'Today')}</i>\n   📂 <i>${escapeHtml(m.category || 'Declared Results')}</i>`
  ).join('\n\n');

  const textMessage = [
    `🎓 <b>VMOU EXAM RESULTS DECLARED!</b> 🎓`,
    `Vardhman Mahaveer Open University, Kota has published exam results for:`,
    ``,
    courseItems,
    ``,
    `🔗 <b>Direct Portal Link:</b> <a href="${portalUrl}">${portalUrl}</a>`,
    `⏱️ <b>Detected:</b> <code>${escapeHtml(checkTimestampIST || formatIST(new Date()))}</code>`,
    `⚡ <i>Cloudflare Workers Edge Monitor (24/7)</i>`
  ].join('\n');

  // Interactive inline keyboard button
  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: '🔗 Open VMOU Result Portal',
          url: portalUrl
        }
      ]
    ]
  };

  try {
    logger.info(`[Telegram Bot] Sending message to Chat ID ${chatId}...`);
    const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: textMessage,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: inlineKeyboard
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      const errMsg = data.description || `HTTP ${response.status} ${response.statusText}`;
      logger.error(`[Telegram Bot] Send message failed: ${errMsg}`, data);
      return {
        channel: 'telegram',
        success: false,
        statusCode: response.status,
        error: errMsg
      };
    }

    logger.info(`[Telegram Bot] Message sent successfully! Message ID: ${data.result?.message_id}`);
    return {
      channel: 'telegram',
      success: true,
      messageId: data.result?.message_id
    };
  } catch (err) {
    logger.error(`[Telegram Bot] Network or execution error: ${err.message}`);
    return {
      channel: 'telegram',
      success: false,
      error: err.message
    };
  }
}

/**
 * ------------------------------------------------------------------------------
 * 3. BROWSER WEB PUSH NOTIFICATION (RFC 8291 / VAPID via @mmmike/web-push)
 * ------------------------------------------------------------------------------
 * Pushes instant native notifications to all subscribed browsers.
 */
export async function sendWebPush(env, { matches = [], portalUrl, checkTimestampIST }) {
  const kv = env.RESULTS_KV || null;
  const subscriptions = await getPushSubscriptions(kv);

  if (!subscriptions || subscriptions.length === 0) {
    logger.info('[Web Push] Skipped: No browser push subscriptions registered yet.');
    return {
      channel: 'webpush',
      success: true,
      skipped: true,
      delivered: 0,
      subscribers: 0,
      reason: 'No registered push subscriptions'
    };
  }

  const vapidPublicKey = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE_KEY;
  const vapidSubject = env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;

  const vapid = {
    publicKey: vapidPublicKey,
    privateKey: vapidPrivateKey,
    subject: vapidSubject
  };

  const firstCourse = matches[0]?.courseName || 'VMOU Results';
  const title = '🎓 VMOU Exam Results Declared!';
  const body = matches.length === 1
    ? `${firstCourse} has been declared on the VMOU portal!`
    : `${matches.length} target courses declared: ${matches.map(m => m.courseName).slice(0, 2).join(' & ')}`;

  const payload = {
    title,
    body,
    url: portalUrl || 'https://online.vmou.ac.in/results.aspx',
    tag: 'vmou-result-alert'
  };

  try {
    logger.info(`[Web Push] Dispatching push notifications to ${subscriptions.length} subscribed devices...`);

    const result = await sendPushBatch(subscriptions, payload, vapid, {
      ttl: 86400,
      urgency: 'high'
    });

    // Defensive access: the library documents { delivered, gone[], failed[] }
    // but guard against unexpected shapes so a library change cannot crash the cron run.
    const delivered = result?.delivered ?? 0;
    const goneEndpoints = Array.isArray(result?.gone) ? result.gone : [];
    const failedSends = Array.isArray(result?.failed) ? result.failed : [];

    logger.info(`[Web Push] Delivered: ${delivered}, Expired/Gone: ${goneEndpoints.length}, Failed: ${failedSends.length}`);

    // Auto-prune dead or unsubscribed endpoints from KV
    if (goneEndpoints.length > 0) {
      await prunePushSubscriptions(kv, goneEndpoints);
    }

    return {
      channel: 'webpush',
      // Success requires at least one real delivery. A batch where every
      // subscription has expired (delivered = 0, gone > 0) is NOT a success.
      success: delivered > 0 || (failedSends.length === 0 && goneEndpoints.length === 0),
      delivered,
      subscribers: subscriptions.length,
      gone: goneEndpoints.length,
      failed: failedSends.length
    };
  } catch (err) {
    logger.error(`[Web Push] Delivery error: ${err.message}`);
    return {
      channel: 'webpush',
      success: false,
      error: err.message
    };
  }
}

/**
 * ------------------------------------------------------------------------------
 * Multi-Channel Orchestration
 * ------------------------------------------------------------------------------
 * Dispatches alerts across all three channels concurrently using Promise.allSettled().
 * Returns comprehensive status summary.
 *
 * @param {Object} env
 * @param {Object} checkResult
 * @returns {Promise<Object>} Aggregated delivery report
 */
export async function notifyAllChannels(env, checkResult) {
  const matches = checkResult.matches || [];
  const portalUrl = checkResult.portalUrl || 'https://online.vmou.ac.in/results.aspx';
  const checkTimestampIST = checkResult.checkTimestampIST;
  const checkTimestampISO = checkResult.checkTimestamp;

  logger.info(`Broadcasting notifications for ${matches.length} matched courses across all channels...`);

  const payload = {
    matches,
    portalUrl,
    checkTimestampIST,
    checkTimestampISO
  };

  const [emailResult, telegramResult, webPushResult] = await Promise.allSettled([
    sendEmail(env, payload),
    sendTelegram(env, payload),
    sendWebPush(env, payload)
  ]);

  const report = {
    email: emailResult.status === 'fulfilled' ? emailResult.value : { success: false, error: emailResult.reason?.message },
    telegram: telegramResult.status === 'fulfilled' ? telegramResult.value : { success: false, error: telegramResult.reason?.message },
    webpush: webPushResult.status === 'fulfilled' ? webPushResult.value : { success: false, error: webPushResult.reason?.message }
  };

  const successfulChannels = Object.entries(report)
    .filter(([_, res]) => res.success && !res.skipped)
    .map(([channel]) => channel);

  const failedChannels = Object.entries(report)
    .filter(([_, res]) => !res.success && !res.skipped)
    .map(([channel, res]) => `${channel} (${res.error})`);

  const skippedChannels = Object.entries(report)
    .filter(([_, res]) => res.skipped)
    .map(([channel]) => channel);

  logger.info(`Notification Broadcast Summary:`, {
    successful: successfulChannels,
    failed: failedChannels,
    skipped: skippedChannels
  });

  return {
    ...report,
    successfulChannels,
    failedChannels,
    skippedChannels,
    // Every dispatched channel succeeded and at least one channel actually dispatched.
    allSucceeded: failedChannels.length === 0 && successfulChannels.length > 0,
    anySucceeded: successfulChannels.length > 0
  };
}

// Basic HTML escaping helper lives in utils.js (shared with the dashboard).
