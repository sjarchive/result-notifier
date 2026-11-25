/**
 * ==============================================================================
 * VMOU Result Notifier - Portal Checker
 * ==============================================================================
 * Reverse-engineered fetch engine for VMOU's ASP.NET results portal.
 *
 * How VMOU's portal (https://online.vmou.ac.in/results.aspx) works:
 * 1. A single GET of /results.aspx renders the full "RESULTS DECLARED" page.
 * 2. Declared results are listed directly inside a server-side rendered
 *    GridView (`OtherContentPlaceHolder_gvResultList`) with the columns:
 *    SL. NO. | PROGRAMME | PROGRAMME CODE | DATE OF DECLARATION | EXAM SESSION
 *    e.g. "1 | BACHELOR OF JOURNALISM (Semester-I) | BJN-1 | 21/10/2026 | JUNE26"
 * 3. No postback, cookies or redirect chain is required — the declared
 *    results list is available in plain HTML on the very first response.
 *
 * Detailed individual result pages live at https://online.vmou.ac.in/result.aspx
 * (student enters enrolment number there), so monitoring only needs this page.
 *
 * This checker executes the flow with standard Cloudflare Workers fetch().
 * ==============================================================================
 */

import { logger, formatIST } from './utils.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 25000;

const DEFAULT_TARGET_URL = 'https://online.vmou.ac.in/results.aspx';
const DETAILED_RESULT_URL = 'https://online.vmou.ac.in/result.aspx';

/**
 * Target Programme Detection Specifications.
 *
 * Matching runs on normalized text (uppercase, punctuation stripped, roman
 * numerals converted to digits: "Semester-II" -> "SEM2"), so exact spelling
 * variations on the portal still match. Programme CODE matching is the
 * primary discriminator; the programme NAME is the secondary fallback.
 */
export const TARGET_COURSE_DEFINITIONS = [
  {
    id: 'MA_POLITICAL_SCIENCE_SEM2',
    name: 'M.A. POLITICAL SCIENCE (Semester-II)',
    description: 'Master of Arts Political Science, Semester-II (VMOU programme code MAPSN-2)',
    codes: ['MAPSN-2']
  }
];

/**
 * Safely discard an unread response body.
 * Prevents resource leaks / runtime warnings when a response is rejected
 * before its body has been consumed (e.g. non-OK status paths).
 */
function discardResponseBody(response) {
  try {
    response?.body?.cancel()?.catch(() => {});
  } catch {
    // Ignore cancellation failures
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

const ROMAN_TO_DIGIT = {
  IX: '9', VIII: '8', VII: '7', VI: '6', IV: '4', V: '5', III: '3', II: '2', I: '1',
  XII: '12', XI: '11', X: '10'
};

/**
 * Decode common HTML entities (named, decimal, and hex).
 * Decodes &amp; LAST to avoid double-unescaping sequences like &amp;lt;.
 */
export function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (full, hex) => {
      const code = Number.parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    })
    .replace(/&#(\d+);/g, (full, dec) => {
      const code = Number.parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    })
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&amp;/gi, '&');
}

/**
 * Canonicalize programme/course text for robust comparison.
 * Example transform chain:
 *   "M.A. POLITICAL SCIENCE (Semester-II)" -> "M.A. POLITICAL SCIENCE (SEMESTER-2)"
 *   -> "MA POLITICAL SCIENCE SEM 2"  ->  "MAPOLITICALSCIENCESEM2"
 * Case, dots, dashes, parentheses and spacing variations all collapse away.
 */
export function normalizeProgrammeText(str) {
  if (!str) return '';
  let text = String(str).toUpperCase();
  // Convert standalone roman numerals to digits BEFORE stripping punctuation
  text = text.replace(/\b(IX|VIII|VII|VI|IV|XII|XI|III|II|X|V|I)\b/g, (m) => ROMAN_TO_DIGIT[m] ?? m);
  // "Semester" and "Sem" collapse to the same token
  text = text.replace(/SEMESTER/g, 'SEM');
  // Strip all non-alphanumeric characters
  return text.replace(/[^A-Z0-9]/g, '');
}

/**
 * Build a boundary-safe RegExp for matching a programme code like "MAPSN-2"
 * against raw uppercase text. Prevents prefix/suffix collisions such as
 * "MAPSN-2" matching "MAPSN-20", "MAPSN-2A", or "XMAPSN-2".
 */
function buildCodeRegex(rawCode) {
  const parts = String(rawCode || '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (parts.length === 0) return null;
  const pattern = `(?<![A-Z0-9])${parts.join('[\\s\\-_/]*')}(?![A-Z0-9])`;
  return new RegExp(pattern, 'i');
}

/**
 * Check whether normalized `haystack` contains normalized `needle` without
 * splitting a trailing number (e.g. "SEM2" must not match "SEM20").
 */
function containsNormalizedBoundarySafe(haystack, needle) {
  if (!haystack || !needle) return false;
  const endsWithDigit = /\d$/.test(needle);
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const afterChar = haystack[idx + needle.length] || '';
    if (!endsWithDigit || !/^\d$/.test(afterChar)) {
      return true;
    }
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * Build the effective target list from environment configuration.
 * TARGET_PROGRAMME_CODES wins if set (comma-separated), otherwise
 * TARGET_PROGRAMME_CODE, otherwise the built-in default above.
 */
export function resolveTargetDefinitions(env = {}) {
  const defaults = TARGET_COURSE_DEFINITIONS;

  const codesRaw = env.TARGET_PROGRAMME_CODES || env.TARGET_PROGRAMME_CODE || defaults[0].codes.join(',');
  const codes = String(codesRaw)
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  const nameRaw = env.TARGET_PROGRAMME_NAME || defaults[0].name;

  return [
    {
      id: defaults[0].id,
      name: nameRaw,
      codes,
      normName: normalizeProgrammeText(nameRaw),
      normCodes: codes.map(normalizeProgrammeText).filter(Boolean),
      codeRegexes: codes.map(buildCodeRegex).filter(Boolean)
    }
  ];
}

/**
 * Find the first matching target definition for a given text string.
 *
 * @param {string} text Combined programme name + code text
 * @param {Array<Object>} targets Resolved target definitions
 * @returns {Object|null}
 */
export function findMatchingTarget(text, targets = []) {
  if (!text || !targets || targets.length === 0) return null;
  const rawUpper = String(text).toUpperCase();
  const normalized = normalizeProgrammeText(rawUpper);
  if (!normalized) return null;

  for (const target of targets) {
    // Primary: boundary-safe programme-code hit (e.g. "MAPSN-2" without matching "MAPSN-20")
    const codeRegexes = target.codeRegexes || (target.codes || []).map(buildCodeRegex).filter(Boolean);
    for (const regex of codeRegexes) {
      if (regex.test(rawUpper)) return target;
    }
    // Secondary: full programme-name hit with digit-boundary guard
    if (target.normName && containsNormalizedBoundarySafe(normalized, target.normName)) {
      return target;
    }
  }
  return null;
}

/**
 * Dedicated matcher for the target programme(s). Codes/names are compared on
 * normalized text so any spelling variation on the VMOU portal still matches.
 *
 * @param {string} text Combined programme name + code text
 * @param {Array<Object>} targets Resolved target definitions
 * @returns {boolean}
 */
export function isTargetProgramme(text, targets = []) {
  return findMatchingTarget(text, targets) !== null;
}

/**
 * Extract clean text lines from HTML for fallback scanning when table parsing
 * yields zero rows. Strips script/style/comment blocks and preserves block breaks.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractReadableText(html) {
  if (!html) return '';
  const stripped = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<(?:\/(?:tr|div|p|li|h[1-6]|section|article|table)|br\s*\/?)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(stripped)
    .split(/[\n\r]+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse the declared exam results table from VMOU results.aspx.
 *
 * @param {string} html
 * @returns {Array<Object>} List of declared results with programme name, code,
 *                          declaration date, and exam session
 */
export function parseDeclaredResultsTable(html) {
  if (!html) return [];
  const rawHtml = String(html);
  const results = [];

  // Avoid matching outer <tr> elements that wrap nested <tr> tables
  const rowRegex = /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi;
  let match;

  while ((match = rowRegex.exec(rawHtml)) !== null) {
    const rowHtml = match[1];
    const textContent = decodeHtmlEntities(rowHtml.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();

    if (!textContent) continue;

    // Skip the grid header row
    if (/SL\.?\s*NO/i.test(textContent) && /PROGRAMME/i.test(textContent)) {
      continue;
    }

    // A data row must have at least 5 <td> cells:
    // SL. NO. | PROGRAMME | PROGRAMME CODE | DATE OF DECLARATION | EXAM SESSION
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(
        decodeHtmlEntities(cellMatch[1].replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .trim()
      );
    }
    if (cells.length < 5) continue;

    const sNo = cells[0];
    const courseName = cells[1];
    const courseCode = cells[2];
    const declaredDate = cells[3];
    const examSession = cells[4].toUpperCase();

    // Data rows have a numeric serial number and a non-empty programme name
    if (!/^\d+$/.test(sNo) || !courseName) continue;

    // Extract optional link href if present inside the row
    const hrefMatch = rowHtml.match(/<a\b[^>]*href=["']([^"']+)["']/i);
    const actionLink = hrefMatch ? decodeHtmlEntities(hrefMatch[1]).trim() : '';

    results.push({
      sNo,
      courseName,
      courseCode,
      declaredDate,
      examSession,
      category: examSession ? `Exam Session ${examSession}` : 'Declared Results',
      rawRowText: textContent,
      actionLink
    });
  }

  return results;
}

/**
 * Filter declared results against the target programme(s).
 *
 * @param {Array<Object>} declaredResults
 * @param {Array<Object>} targets       Resolved target definitions
 * @param {string} targetSession        e.g. "JUNE26" ("" disables session filter)
 * @param {string} fullPageText         used ONLY if table parsing yielded 0 rows
 * @returns {Array<Object>} Matched target results
 */
export function identifyTargetMatches(declaredResults, targets, targetSession = '', fullPageText = '') {
  const matches = [];
  const normalizedSession = targetSession ? normalizeProgrammeText(targetSession) : '';

  for (const item of declaredResults) {
    const targetText = `${item.courseName} ${item.courseCode || ''}`;

    // Optional exam-session filter: "JUNE26", "DEC25", etc.
    if (normalizedSession && normalizeProgrammeText(item.examSession || '') !== normalizedSession) {
      continue;
    }

    const matchedTarget = findMatchingTarget(targetText, targets);
    if (matchedTarget) {
      matches.push({
        targetDefinitionId: matchedTarget.id || 'TARGET_PROGRAMME',
        targetKey: item.courseCode || matchedTarget.name || item.courseName,
        courseName: item.courseName,
        courseCode: item.courseCode || '',
        declaredDate: item.declaredDate,
        examSession: item.examSession || '',
        category: item.category,
        actionLink: item.actionLink,
        rawRowText: item.rawRowText
      });
    }
  }

  // Fallback scan: ONLY triggers if table parsing found ZERO rows (e.g. portal layout changed).
  // Never runs when the table parsed successfully (prevents false positives from other exam sessions).
  if (declaredResults.length === 0 && matches.length === 0 && fullPageText) {
    const lines = String(fullPageText).split(/[\n\r]+|\s{2,}/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length <= 3 || trimmed.length > 400) continue;

      // Respect exam session filter during fallback scan as well
      if (normalizedSession && !containsNormalizedBoundarySafe(normalizeProgrammeText(trimmed), normalizedSession)) {
        continue;
      }

      const matchedTarget = findMatchingTarget(trimmed, targets);
      if (matchedTarget) {
        logger.warn(`Fallback content scan detected target programme: "${trimmed}"`);
        matches.push({
          targetDefinitionId: matchedTarget.id || 'TARGET_PROGRAMME',
          targetKey: matchedTarget.codes?.[0] || matchedTarget.name || trimmed,
          courseName: trimmed,
          declaredDate: 'Recently Declared',
          examSession: targetSession ? targetSession.toUpperCase() : '',
          category: targetSession ? `Exam Session ${targetSession.toUpperCase()}` : 'Declared Results',
          actionLink: '',
          rawRowText: `Detected via fallback content scan: "${trimmed}"`
        });
        break;
      }
    }
  }

  return matches;
}

/**
 * Execute the complete VMOU check pipeline.
 *
 * @param {Object} env Cloudflare Workers environment variables and secrets
 * @returns {Promise<Object>} Detailed check summary
 */
export async function checkVMOUResults(env = {}) {
  const startTime = Date.now();
  const baseUrl = (env.TARGET_URL || DEFAULT_TARGET_URL).replace(/\/+$/, '');
  const targetSession = env.TARGET_SESSION != null ? String(env.TARGET_SESSION).trim() : 'JUNE26';
  const targets = resolveTargetDefinitions(env);

  logger.info(`Starting VMOU examination results check for session [${targetSession || 'ALL'}]...`, {
    targetUrl: baseUrl,
    targetProgrammes: targets.map(t => `${t.name} (${t.codes.join(', ')})`)
  });

  const diagnostics = {
    pageStatus: null,
    stepsCompleted: []
  };

  // --------------------------------------------------------------------------
  // STEP 1: Fetch the declared-results page (single request, no postback)
  // --------------------------------------------------------------------------
  logger.info(`Step 1: Fetching results page at ${baseUrl}...`);
  const pageResponse = await fetchWithTimeout(baseUrl, {
    method: 'GET',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  diagnostics.pageStatus = pageResponse.status;
  if (!pageResponse.ok) {
    discardResponseBody(pageResponse);
    throw new Error(`Failed to load VMOU results page: HTTP ${pageResponse.status} ${pageResponse.statusText}`);
  }

  const pageHtml = await pageResponse.text();
  diagnostics.stepsCompleted.push('results_page_loaded');

  // --------------------------------------------------------------------------
  // STEP 2: Parse & Detect Target Programmes
  // --------------------------------------------------------------------------
  logger.info(`Step 2: Parsing results page content (${pageHtml.length} bytes)...`);
  const allDeclaredResults = parseDeclaredResultsTable(pageHtml);
  logger.info(`Found total ${allDeclaredResults.length} declared exam results on page.`);

  const readableText = allDeclaredResults.length === 0 ? extractReadableText(pageHtml) : '';
  const matchedTargets = identifyTargetMatches(allDeclaredResults, targets, targetSession, readableText);

  const durationMs = Date.now() - startTime;
  const now = new Date();

  logger.info(`Check completed in ${durationMs}ms. Matched targets found: ${matchedTargets.length}`);
  if (matchedTargets.length > 0) {
    logger.info(`🎉 TARGET RESULTS DETECTED:`, {
      courses: matchedTargets.map(m => m.courseName)
    });
  }

  return {
    success: true,
    portalUrl: baseUrl,
    resultPageUrl: DETAILED_RESULT_URL,
    targetSession,
    checkTimestamp: now.toISOString(),
    checkTimestampIST: formatIST(now),
    durationMs,
    totalDeclaredOnPage: allDeclaredResults.length,
    allDeclaredResults,
    hasMatches: matchedTargets.length > 0,
    matches: matchedTargets,
    matchedCourseNames: matchedTargets.map(m => m.courseName),
    diagnostics
  };
}
