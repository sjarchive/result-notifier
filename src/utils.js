/**
 * ==============================================================================
 * VMOU Result Notifier - Utilities
 * ==============================================================================
 * Comprehensive helper functions for:
 * 1. Precision logging with milliseconds & IST timezone
 * 2. Asynchronous retry logic with exponential backoff & jitter
 * 3. Cloudflare KV state storage management
 * 4. Dead man's switch detection
 * 5. Notification deduplication fingerprints
 * ==============================================================================
 */

/**
 * Format a Date object into human-readable Indian Standard Time (IST, UTC+5:30).
 * VMOU (Vardhman Mahaveer Open University) is located in Kota, Rajasthan, India.
 *
 * @param {Date|string|number} dateInput
 * @returns {string} Formatted date string, e.g. "12/10/2026, 04:30:15 AM IST"
 */
export function formatIST(dateInput = new Date()) {
  const date = typeof dateInput === 'object' && dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return 'Invalid Date';

  try {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    return `${formatter.format(date)} IST`;
  } catch {
    // Fallback if Intl timeZone is unavailable
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffset);
    return `${istDate.toISOString().replace('T', ' ').replace('Z', '')} (UTC+5:30)`;
  }
}

/**
 * Get current ISO timestamp with high precision.
 * @returns {string} e.g. "2026-10-11T23:15:30.450Z"
 */
export function getNowIso() {
  return new Date().toISOString();
}

/**
 * Basic HTML escaping helper (shared across worker modules).
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Structured logger with high precision timestamps.
 * Methods reference `logger` explicitly (not `this`) so they remain safe
 * when destructured or rebound to another context.
 */
export const logger = {
  formatMessage(level, message, meta = {}) {
    const now = new Date();
    const iso = now.toISOString();
    const ist = formatIST(now);
    const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
    return `[${iso}] [${ist}] [${level.toUpperCase()}] ${message}${metaStr}`;
  },

  info(message, meta) {
    console.log(logger.formatMessage('INFO', message, meta));
  },

  warn(message, meta) {
    console.warn(logger.formatMessage('WARN', message, meta));
  },

  error(message, meta) {
    console.error(logger.formatMessage('ERROR', message, meta));
  },

  debug(message, meta) {
    console.debug(logger.formatMessage('DEBUG', message, meta));
  }
};

/**
 * Sleep helper for retry backoff.
 * @param {number} ms 
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an asynchronous function with automatic retry and exponential backoff.
 *
 * @param {Function} fn Function to execute
 * @param {Object} options Configuration options
 * @param {number} options.maxRetries Maximum retry attempts (default: 3)
 * @param {number} options.baseDelayMs Initial delay before first retry (default: 1000)
 * @param {number} options.maxDelayMs Cap on backoff delay (default: 8000)
 * @param {string} options.context Context label for logs
 * @returns {Promise<any>}
 */
export async function withRetry(fn, {
  maxRetries = 3,
  baseDelayMs = 1000,
  maxDelayMs = 8000,
  context = 'operation'
} = {}) {
  let attempt = 0;
  let lastError;

  while (attempt <= maxRetries) {
    try {
      const startTime = Date.now();
      const result = await fn(attempt);
      const durationMs = Date.now() - startTime;
      if (attempt > 0) {
        logger.info(`[${context}] Succeeded on retry attempt ${attempt}/${maxRetries} (${durationMs}ms)`);
      }
      return result;
    } catch (err) {
      lastError = err;
      attempt++;

      if (attempt > maxRetries) {
        logger.error(`[${context}] Failed after ${maxRetries} retries: ${err.message}`, {
          stack: err.stack
        });
        break;
      }

      // Exponential backoff with random jitter: (base * 2^(attempt-1)) + random(0..500ms)
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + jitter, maxDelayMs);

      logger.warn(`[${context}] Attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ==============================================================================
// State & Cloudflare KV Management
// ==============================================================================

// NOTE: KV key names are intentionally kept stable (the "mlsu_" prefix is a
// legacy identifier). Renaming them would orphan the production state and wipe
// already-registered Web Push subscriptions.
const KV_STATE_KEY = 'mlsu_monitor_state';
const DEFAULT_STATE = {
  lastCheckTimestamp: null,
  lastCheckTimestampIST: null,
  lastCheckStatus: 'never_run',
  lastDurationMs: 0,
  totalChecks: 0,
  consecutiveErrors: 0,
  lastError: null,
  detectedResults: [],
  notifiedFingerprints: [],
  lastNotificationTimestamp: null,
  lastNotificationStatus: null,
  errorHistory: []
};

/**
 * Retrieve current monitor state from Cloudflare KV.
 *
 * @param {KVNamespace|null} kv
 * @returns {Promise<Object>}
 */
export async function getState(kv) {
  if (!kv) {
    logger.warn('KV namespace not bound. Running with in-memory state defaults.');
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = await kv.get(KV_STATE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    logger.error(`Failed to read state from KV: ${err.message}`);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Persist updated monitor state to Cloudflare KV.
 *
 * @param {KVNamespace|null} kv
 * @param {Object} partialState
 * @returns {Promise<Object>}
 */
export async function updateState(kv, partialState) {
  if (!kv) return partialState;

  try {
    const currentState = await getState(kv);
    const updatedState = {
      ...currentState,
      ...partialState
    };
    await kv.put(KV_STATE_KEY, JSON.stringify(updatedState));
    return updatedState;
  } catch (err) {
    logger.error(`Failed to write state to KV: ${err.message}`);
    return partialState;
  }
}

/**
 * Record a successful check iteration in KV.
 *
 * @param {KVNamespace|null} kv
 * @param {Object} checkResult Result from checker
 * @param {number} durationMs Check duration in milliseconds
 */
export async function recordCheckSuccess(kv, checkResult, durationMs) {
  const now = new Date();
  const currentState = await getState(kv);

  return await updateState(kv, {
    lastCheckTimestamp: now.toISOString(),
    lastCheckTimestampIST: formatIST(now),
    lastCheckStatus: 'success',
    lastDurationMs: durationMs,
    totalChecks: (currentState.totalChecks || 0) + 1,
    consecutiveErrors: 0,
    lastError: null,
    detectedResults: checkResult.matches || []
  });
}

/**
 * Record a check error iteration in KV.
 *
 * @param {KVNamespace|null} kv
 * @param {Error|string} error
 * @param {number} durationMs
 */
export async function recordCheckError(kv, error, durationMs) {
  const now = new Date();
  const errorMessage = typeof error === 'string' ? error : (error?.message || 'Unknown error');
  const currentState = await getState(kv);

  const errorEntry = {
    timestamp: now.toISOString(),
    timestampIST: formatIST(now),
    message: errorMessage,
    durationMs
  };

  const errorHistory = [errorEntry, ...(currentState.errorHistory || [])].slice(0, 10);

  return await updateState(kv, {
    lastCheckTimestamp: now.toISOString(),
    lastCheckTimestampIST: formatIST(now),
    lastCheckStatus: 'error',
    lastDurationMs: durationMs,
    totalChecks: (currentState.totalChecks || 0) + 1,
    consecutiveErrors: (currentState.consecutiveErrors || 0) + 1,
    lastError: errorMessage,
    errorHistory
  });
}

/**
 * Generate a unique deterministic fingerprint for a list of detected results
 * to avoid spamming alerts every 5 minutes when the results remain declared.
 *
 * @param {Array<Object>} matches
 * @returns {string}
 */
export function computeResultsFingerprint(matches = []) {
  if (!matches || !matches.length) return '';
  const normalized = matches
    .map(m => `${(m.courseName || '').toLowerCase().trim()}|${(m.declaredDate || '').toLowerCase().trim()}`)
    .sort()
    .join(';;');
  return normalized;
}

/**
 * Determine whether notifications should be dispatched.
 * Dispatches if results are detected AND their fingerprint has not been
 * notified before (deduplication).
 *
 * @param {Object} state
 * @param {Array<Object>} currentMatches
 * @returns {boolean}
 */
export function shouldDispatchNotification(state, currentMatches = []) {
  if (!currentMatches || currentMatches.length === 0) return false;

  const currentFingerprint = computeResultsFingerprint(currentMatches);
  const notified = state.notifiedFingerprints || [];

  return !notified.includes(currentFingerprint);
}

// Cap the stored fingerprint history so KV state cannot grow unbounded over
// months of monitoring. 50 entries is far more than any realistic session.
const MAX_NOTIFIED_FINGERPRINTS = 50;

/**
 * Record that notification was sent for current fingerprint.
 *
 * @param {KVNamespace|null} kv
 * @param {Array<Object>} matches
 * @param {Object} notificationStatus
 */
export async function recordNotificationDispatched(kv, matches, notificationStatus) {
  const now = new Date();
  const fingerprint = computeResultsFingerprint(matches);
  const currentState = await getState(kv);

  const updatedFingerprints = Array.from(new Set([
    ...(currentState.notifiedFingerprints || []),
    fingerprint
  ])).filter(Boolean).slice(-MAX_NOTIFIED_FINGERPRINTS);

  return await updateState(kv, {
    lastNotificationTimestamp: now.toISOString(),
    lastNotificationTimestampIST: formatIST(now),
    lastNotificationStatus: notificationStatus,
    notifiedFingerprints: updatedFingerprints
  });
}

// Key for in-flight notification dispatch lock in KV
const KV_DISPATCH_LOCK_KEY = 'mlsu_lock_notification_dispatch';
let inMemoryLockUntil = 0;

/**
 * Attempt to acquire an exclusive lock in KV for notification dispatching.
 * Prevents multiple worker instances or multiple Cloudflare PoPs from sending
 * duplicate notifications concurrently.
 *
 * @param {KVNamespace|null} kv
 * @param {number} ttlSeconds Maximum lock duration in seconds (default: 60)
 * @returns {Promise<boolean>} True if lock was acquired, false if already held
 */
export async function acquireDispatchLock(kv, ttlSeconds = 60) {
  const now = Date.now();

  if (!kv) {
    if (inMemoryLockUntil > now) {
      return false;
    }
    inMemoryLockUntil = now + (ttlSeconds * 1000);
    return true;
  }

  try {
    const existingLock = await kv.get(KV_DISPATCH_LOCK_KEY);
    if (existingLock) {
      const lockData = JSON.parse(existingLock);
      // If active lock exists and has not expired, block concurrent execution
      if (lockData.expiresAt && lockData.expiresAt > now) {
        logger.warn(`Dispatch lock currently active (held by instance ${lockData.holderId || 'unknown'}).`);
        return false;
      }
    }

    const holderId = Math.random().toString(36).substring(2, 9);
    const lockPayload = JSON.stringify({
      holderId,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: now + (ttlSeconds * 1000)
    });

    // Cloudflare KV expirationTtl must be >= 60 seconds
    await kv.put(KV_DISPATCH_LOCK_KEY, lockPayload, {
      expirationTtl: Math.max(60, ttlSeconds)
    });

    return true;
  } catch (err) {
    logger.warn(`Failed to verify dispatch lock in KV: ${err.message}. Using in-memory mutex.`);
    if (inMemoryLockUntil > now) return false;
    inMemoryLockUntil = now + (ttlSeconds * 1000);
    return true;
  }
}

/**
 * Release the exclusive notification dispatch lock.
 *
 * @param {KVNamespace|null} kv
 */
export async function releaseDispatchLock(kv) {
  inMemoryLockUntil = 0;
  if (!kv) return;

  try {
    await kv.delete(KV_DISPATCH_LOCK_KEY);
  } catch (err) {
    logger.warn(`Failed to delete dispatch lock from KV: ${err.message}`);
  }
}

/**
 * Check if notifications are currently within cooldown.
 *
 * @param {Object} state Monitor state
 * @param {number} cooldownMinutes Minimum minutes between notifications (default: 5)
 * @returns {{ inCooldown: boolean, remainingSeconds: number, elapsedSeconds: number }}
 */
export function checkNotificationCooldown(state, cooldownMinutes = 5) {
  if (!state || !state.lastNotificationTimestamp) {
    return { inCooldown: false, remainingSeconds: 0, elapsedSeconds: Infinity };
  }

  const lastNotifTime = new Date(state.lastNotificationTimestamp).getTime();
  if (isNaN(lastNotifTime)) {
    return { inCooldown: false, remainingSeconds: 0, elapsedSeconds: Infinity };
  }

  const cooldownMs = cooldownMinutes * 60 * 1000;
  const elapsedMs = Date.now() - lastNotifTime;

  if (elapsedMs < cooldownMs) {
    const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    return { inCooldown: true, remainingSeconds, elapsedSeconds };
  }

  return { inCooldown: false, remainingSeconds: 0, elapsedSeconds: Math.floor(elapsedMs / 1000) };
}

/**
 * Dead Man's Switch: Check if the worker missed scheduled runs.
 * If more than `thresholdMinutes` have passed since the last check,
 * the switch is tripped.
 *
 * @param {Object} state
 * @param {number} thresholdMinutes
 * @returns {{ tripped: boolean, elapsedSeconds: number, elapsedMinutes: number, message: string }}
 */
export function evaluateDeadManSwitch(state, thresholdMinutes = 10) {
  if (!state || !state.lastCheckTimestamp) {
    return {
      tripped: false,
      elapsedSeconds: 0,
      elapsedMinutes: 0,
      message: 'Initial check has not run yet.'
    };
  }

  const lastCheckTime = new Date(state.lastCheckTimestamp).getTime();
  const now = Date.now();
  const elapsedMs = Math.max(0, now - lastCheckTime);
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const elapsedMinutes = (elapsedMs / (60 * 1000)).toFixed(1);
  const thresholdMs = thresholdMinutes * 60 * 1000;

  const tripped = elapsedMs > thresholdMs;

  return {
    tripped,
    elapsedSeconds,
    elapsedMinutes: Number(elapsedMinutes),
    thresholdMinutes,
    message: tripped
      ? `DEAD MAN'S SWITCH TRIPPED: No check has run for ${elapsedMinutes} minutes (Threshold: ${thresholdMinutes}m)!`
      : `Operational: Last check was ${elapsedMinutes} minutes ago.`
  };
}

// ==============================================================================
// Web Push Subscription KV Storage & VAPID Defaults
// ==============================================================================

export const DEFAULT_VAPID_PUBLIC_KEY =
  'BFpXgH_5tSF26iQhC797D92RhsUwwh7TNds43PKgGk6U8zovuSq7ytP71XbN3I6t82ooEwtdbfDqQvCpahKn_68';
export const DEFAULT_VAPID_PRIVATE_KEY =
  '_38TQ0jyMY0V3ci22bMQQOT7fSzGKxTAmoSqFy55huM';
export const DEFAULT_VAPID_SUBJECT =
  'https://result-notifier.nvy.workers.dev';

const KV_PUSH_SUBS_KEY = 'mlsu_push_subscriptions';

// In-memory fallback for local testing without KV
let inMemoryPushSubs = [];

/**
 * Retrieve all registered Web Push subscriptions from KV.
 *
 * @param {KVNamespace|null} kv
 * @returns {Promise<Array<Object>>}
 */
export async function getPushSubscriptions(kv) {
  if (!kv) {
    return inMemoryPushSubs;
  }

  try {
    const raw = await kv.get(KV_PUSH_SUBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.error(`Failed to get push subscriptions from KV: ${err.message}`);
    return [];
  }
}

/**
 * Save or update a Web Push subscription in KV.
 *
 * @param {KVNamespace|null} kv
 * @param {Object} subscription PushSubscriptionData { endpoint, keys: { p256dh, auth } }
 * @param {string} userAgent
 * @returns {Promise<{ count: number, isNew: boolean }>}
 */
export async function savePushSubscription(kv, subscription, userAgent = '') {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Invalid push subscription structure');
  }

  const existing = await getPushSubscriptions(kv);
  const normalizedEndpoint = subscription.endpoint.trim();
  const existingIndex = existing.findIndex(s => s.endpoint === normalizedEndpoint);

  const newSubEntry = {
    endpoint: normalizedEndpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth
    },
    userAgent: userAgent.slice(0, 200),
    updatedAt: new Date().toISOString()
  };

  let updatedList;
  let isNew = false;

  if (existingIndex >= 0) {
    updatedList = [...existing];
    updatedList[existingIndex] = {
      ...existing[existingIndex],
      ...newSubEntry
    };
  } else {
    isNew = true;
    newSubEntry.createdAt = new Date().toISOString();
    updatedList = [...existing, newSubEntry];
  }

  if (!kv) {
    inMemoryPushSubs = updatedList;
  } else {
    try {
      await kv.put(KV_PUSH_SUBS_KEY, JSON.stringify(updatedList));
    } catch (err) {
      logger.error(`Failed to persist push subscription to KV: ${err.message}`);
    }
  }

  logger.info(`Web Push subscription stored (Total subscribers: ${updatedList.length}, isNew: ${isNew})`);
  return { count: updatedList.length, isNew };
}

/**
 * Remove a specific Web Push subscription by its endpoint.
 *
 * @param {KVNamespace|null} kv
 * @param {string} endpoint
 * @returns {Promise<{ count: number, removed: boolean }>}
 */
export async function removePushSubscription(kv, endpoint) {
  if (!endpoint) return { count: 0, removed: false };

  const existing = await getPushSubscriptions(kv);
  const filtered = existing.filter(s => s.endpoint !== endpoint);
  const removed = filtered.length < existing.length;

  if (!kv) {
    inMemoryPushSubs = filtered;
  } else if (removed) {
    try {
      await kv.put(KV_PUSH_SUBS_KEY, JSON.stringify(filtered));
    } catch (err) {
      logger.error(`Failed to remove push subscription from KV: ${err.message}`);
    }
  }

  logger.info(`Web Push subscription removed (Remaining: ${filtered.length})`);
  return { count: filtered.length, removed };
}

/**
 * Prune a list of defunct endpoints (e.g. expired 410 Gone / 404 from push service).
 *
 * @param {KVNamespace|null} kv
 * @param {Array<string>} endpointsToRemove
 * @returns {Promise<number>} Number of pruned subscriptions
 */
export async function prunePushSubscriptions(kv, endpointsToRemove = []) {
  if (!endpointsToRemove || endpointsToRemove.length === 0) return 0;

  const toRemoveSet = new Set(endpointsToRemove);
  const existing = await getPushSubscriptions(kv);
  const filtered = existing.filter(s => !toRemoveSet.has(s.endpoint));
  const prunedCount = existing.length - filtered.length;

  if (prunedCount > 0) {
    if (!kv) {
      inMemoryPushSubs = filtered;
    } else {
      try {
        await kv.put(KV_PUSH_SUBS_KEY, JSON.stringify(filtered));
      } catch (err) {
        logger.error(`Failed to prune push subscriptions in KV: ${err.message}`);
      }
    }
    logger.info(`Pruned ${prunedCount} defunct Web Push subscriptions (Remaining: ${filtered.length})`);
  }

  return prunedCount;
}

