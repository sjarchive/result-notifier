# 🎓 VMOU University Exam Result Notifier (Cloudflare Worker)

A production-grade, 100% autonomous serverless monitor built for **Cloudflare Workers**. It monitors the **Vardhman Mahaveer Open University (VMOU), Kota** results portal every 5 minutes and broadcasts instant notifications across **Browser Web Push**, **Email (Resend)**, and **Telegram Bot** when the target programme result is declared.

- **Live Dashboard**: [https://result-notifier.nvy.workers.dev/](https://result-notifier.nvy.workers.dev/)
- Runs 24/7 on Cloudflare's global edge network without requiring your computer to stay on.
- **Continuous Deployment**: every push to `main` is automatically built and deployed to the Cloudflare Worker via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (`npx wrangler deploy`). The GitHub repo is the source of truth — the monitor keeps running even if the local clone is deleted.

---

## 📌 Target Specifications

- **Target Portal**: [https://online.vmou.ac.in/results.aspx](https://online.vmou.ac.in/results.aspx)
- **Target Programme**: `M.A. POLITICAL SCIENCE (Semester-II)`
- **Programme Code**: `MAPSN-2`
- **Exam Session Filter**: `JUNE26` (the "EXAM SESSION" column on the portal)
- **Interval**: Every 5 minutes (`*/5 * * * *` Cron Trigger)
- **Deduplication**: Alerts are sent once per detected programme result to avoid repetitive notification spam.
- **Dead Man's Switch**: If no check has completed for > 10 minutes, triggers an alert state.

### How the Programme Matcher Works
Matching is done on normalized text: casing, dots, dashes, parentheses and spaces are stripped, and roman numerals are converted to digits. This means the worker matches the target regardless of how the portal spells it:

| Portal Row Text | Matched? |
| :--- | :--- |
| `M.A. POLITICAL SCIENCE (Semester-II)` + code `MAPSN-2` | ✅ |
| `M.A. POLITICAL SCIENCE (SEMESTER 2)` / `(Sem-II)` / `(Semester-2)` | ✅ |
| `M.A. POLITICAL SCIENCE (FINAL)` / `(Semester-I)` | ❌ |
| `M.A. POLICE ADMINISTRATION (Semester-*)` | ❌ (look-alike) |
| `BACHELOR OF ARTS (ADDITIONAL SUBJECT-POLITICAL SCIENCE)` | ❌ (look-alike) |

Programme code matching (`MAPSN-2`) is the primary discriminator; the programme name is the fallback.

---

## 🏗️ Architecture & How It Works

VMOU's results portal server-renders the full "RESULTS DECLARED" list directly on one page, so — unlike typical ASP.NET WebForms portals — no postback chain, cookies, or redirects are required. The worker makes a single HTTP GET and parses the grid:

```
[Cloudflare Cron (*/5 * * * *)]
              │
              ▼
   1. GET https://online.vmou.ac.in/results.aspx
      └── Server-rendered GridView (gvResultList) returns all declared results:
          SL. NO. | PROGRAMME | PROGRAMME CODE | DATE OF DECLARATION | EXAM SESSION
              │
              ▼
   2. Parser & Programme Matcher
      ├── Extracts S.No, Programme, Code, Declaration Date & Exam Session per row
      └── Runs normalized code/name matching for MAPSN-2 (all spelling variations)
              │
         [Match Found?]
         ├── NO  ──> Persist check stats to Cloudflare KV ──> Sleep
         └── YES ──> Check KV fingerprint (avoid duplicates)
                     │
                     ▼
         [Broadcast Alerts Concurrently via Promise.allSettled]
         ├── 🔔 Browser Web Push (Direct to phones/PCs via Service Worker & VAPID)
         ├── 📧 Resend (Transactional HTML Email)
         └── 🤖 Telegram Bot (HTML alert + Inline Action Button)
```

Individual (student-wise) results live at [https://online.vmou.ac.in/result.aspx](https://online.vmou.ac.in/result.aspx) — the monitor links there once a new declaration is detected.

---

## 📁 Project Structure

```
result-notifier/
├── package.json          # Worker metadata, scripts, and dependencies
├── wrangler.toml         # Cloudflare Worker config, Cron trigger, KV bindings, env vars
├── test-local.mjs        # Local test runner (tests live VMOU portal without deployment)
├── src/
│   ├── index.js          # Main worker: scheduled cron handler, HTTP router, service worker & web dashboard
│   ├── checker.js        # VMOU results.aspx fetcher, table parser & programme matcher
│   ├── notifications.js  # Web Push (VAPID), Resend (Email), and Telegram Bot handlers
│   └── utils.js          # High-precision IST logging, retry logic, KV state, push sub storage
└── README.md             # Complete step-by-step documentation
```

---

## ⚙️ Configuration

All targets are configurable via `[vars]` in `wrangler.toml` (no code changes needed to retarget):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TARGET_URL` | `https://online.vmou.ac.in/results.aspx` | Results page to poll |
| `TARGET_PROGRAMME_CODE` | `MAPSN-2` | Programme code(s) to watch (comma-separated for multiple) |
| `TARGET_PROGRAMME_NAME` | `M.A. POLITICAL SCIENCE (Semester-II)` | Programme name used as fallback matcher & display |
| `TARGET_SESSION` | `JUNE26` | "EXAM SESSION" filter (`""` disables the session filter) |
| `TIMEZONE` | `Asia/Kolkata` | Timestamps timezone |
| `CHECK_INTERVAL_MINUTES` | `5` | Cron cadence reference |
| `DEAD_MAN_THRESHOLD_MINUTES` | `10` | Dead man's switch threshold |
| `MAX_RETRIES` | `3` | Per-check network retries |

---

## 💰 100% Free Tier Cost Breakdown

This project is engineered to operate comfortably within the free tier of every provider:

| Service | Free Tier Allowance | Project Consumption | Cost |
| :--- | :--- | :--- | :--- |
| **Cloudflare Workers** | 100,000 requests/day | 288 cron runs/day | **$0.00 / free** |
| **Cloudflare KV** | 100,000 reads/day, 1,000 writes/day | ~576 operations/day | **$0.00 / free** |
| **Browser Web Push (VAPID)** | 100% Free & Unlimited | Direct to browser push services (FCM/Apple/Mozilla) | **$0.00 / free** |
| **Resend (Email)** | 100 emails/day, 3,000/month | 1-5 notification emails upon declaration | **$0.00 / free** |
| **Telegram Bot API** | 100% Free & Unlimited | Unlimited messages & buttons | **$0.00 / free** |

---

## 🚀 Step-by-Step Deployment Guide

### Prerequisites
- [Node.js](https://nodejs.org/) v18.0.0 or higher
- A free [Cloudflare Account](https://dash.cloudflare.com/sign-up)

---

### Step 1: Install Wrangler CLI & Authenticate

Open your terminal, navigate to the project directory, and log in to Cloudflare:

```bash
cd result-notifier
npm install
npx wrangler login
```
*(A browser window will open asking you to authorize Wrangler with your Cloudflare account).*

---

### Step 2: Create Cloudflare KV Namespace

Create a production KV namespace to store monitor state and prevent duplicate alerts:

```bash
npx wrangler kv:namespace create RESULTS_KV
```

This command will output something like:
```toml
[[kv_namespaces]]
binding = "RESULTS_KV"
id = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
```

Open `wrangler.toml` and paste the generated `id`:

```toml
[[kv_namespaces]]
binding = "RESULTS_KV"
id = "YOUR_ACTUAL_KV_ID_HERE"
```

---

### Step 3: Setting Up Notification Services

> **ℹ️ Current configuration: Web Push only.**
> Email and Telegram channels are **temporarily disabled** via `ENABLE_EMAIL = "false"` and `ENABLE_TELEGRAM = "false"` in `wrangler.toml`. To re-enable one later, set the flag to `"true"` and configure its secrets (Steps B/C below).

#### A. Browser Web Push Notifications (Zero Configuration Needed! — ACTIVE CHANNEL)
1. Visit your live worker dashboard: [https://result-notifier.nvy.workers.dev/](https://result-notifier.nvy.workers.dev/) on any device (phone or PC).
2. Click or tap **🔔 Turn on Push Notifications**.
3. When the browser prompts you, click **Allow**.
4. That's it! Your device is securely subscribed via VAPID and stored in Cloudflare KV. You will receive native system notifications the instant results are published — even when your browser is closed.
5. Tap **🧪 Send Test Push to this Device** to verify the notification popup right away.

#### B. Resend (Email - Optional, CURRENTLY DISABLED)
1. Sign up at [resend.com](https://resend.com).
2. Go to **API Keys** -> **Create API Key** (e.g. `vmou-notifier`). Copy the key (starts with `re_...`).
3. For testing, Resend provides the free sender `onboarding@resend.dev` which can send emails directly to your registered account email.

#### C. Telegram Bot & Chat ID (Optional, CURRENTLY DISABLED)
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a name (e.g. `VMOU Result Bot`) and username (e.g. `vmou_result_alert_bot`).
3. BotFather will provide an API token (e.g. `7123456789:AAH...`).
4. Start a chat with your newly created bot (click `Start`).
5. To get your personal **Chat ID**:
   - Send `/start` to [@userinfobot](https://t.me/userinfobot) or visit:
     `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Locate the `"id"` field under `"chat"` (e.g. `987654321`).

---

### Step 4: Configure Cloudflare Secrets (Optional, CURRENTLY DISABLED)

> **ℹ️** These steps are only needed if/when you re-enable Email or Telegram.
> To **remove** previously stored channel secrets, run:
> ```bash
> npx wrangler secret delete RESEND_API_KEY
> npx wrangler secret delete EMAIL_FROM
> npx wrangler secret delete EMAIL_TO
> npx wrangler secret delete TELEGRAM_BOT_TOKEN
> npx wrangler secret delete TELEGRAM_CHAT_ID
> ```
> (Existing unused secrets are harmless while the channels are disabled, but deleting them keeps the account clean.)

If using Email or Telegram, configure your credentials in Cloudflare's secrets manager:

```bash
# 1. Resend Email Secrets (Optional)
npx wrangler secret put RESEND_API_KEY
# Enter your key: re_xxxxxxxxxxxxxxxxxxxx

npx wrangler secret put EMAIL_FROM
# Enter sender: VMOU Exam Alert <onboarding@resend.dev>

npx wrangler secret put EMAIL_TO
# Enter your recipient email: your-email@gmail.com

# 2. Telegram Bot Secrets (Optional)
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Enter Bot Token: 7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxx

npx wrangler secret put TELEGRAM_CHAT_ID
# Enter Chat ID: 987654321
```

*(Note: Browser Push Notifications require zero secrets setup — VAPID keys are pre-configured out-of-the-box! If you only want Browser Push Notifications, you can skip Step 4 entirely).*

---

### Step 5: Deploy the Worker

Deploy your worker live to Cloudflare's edge network:

```bash
npm run deploy
```

You will see output similar to:
```
Total Upload: xx KiB / gzip: xx KiB
Uploaded result-notifier
Deployed result-notifier triggers [crons: ["*/5 * * * *"]]
Published result-notifier
  https://result-notifier.nvy.workers.dev
```

---

## 🧪 Testing & Verification

### 0. Local Verification (No Deployment Needed)
Run the local test suite — it checks the programme matcher, notification fallbacks, and executes a **live check against the real VMOU portal**:

```bash
npm test
```

### 1. View the Live Web Dashboard
Open your live URL in any browser:
```
https://result-notifier.nvy.workers.dev/
```
You will see the visual dashboard showing:
- Current health status (`● OPERATIONAL`)
- Interactive **Browser Push Notification** controller and device status
- Last check timestamp (in IST) and duration
- Dead man's switch status
- Configured notification channels
- Currently declared results on the VMOU portal

### 2. Test All Notification Channels (Test Alert)
Send a test message across Browser Web Push, Email, and Telegram with mock result data:
```bash
curl https://result-notifier.nvy.workers.dev/test-notify
```
Or test browser push specifically:
```bash
curl -X POST https://result-notifier.nvy.workers.dev/api/push/test
```

### 3. Run an Immediate Portal Check
Trigger a manual live check against VMOU right now (notifications follow the standard deduplication rules):
```bash
curl https://result-notifier.nvy.workers.dev/check-now
```

### 4. Health Check Endpoint (For Uptime Monitors)
```bash
curl https://result-notifier.nvy.workers.dev/health
```

### 5. Stream Live Logs in Real Time
To watch cron runs execute live every 5 minutes:
```bash
npm run tail
```

---

## 🛑 How to Stop or Pause the Worker After Results Are Declared

Once you have received your result and no longer need the worker to poll the portal:

### Option A: Delete the Worker (Recommended when finished)
```bash
npx wrangler delete
```

### Option B: Pause Cron Triggers via Cloudflare Dashboard
1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Go to **Workers & Pages** -> Select `result-notifier`.
3. Go to **Triggers** -> **Cron Triggers**.
4. Disable or delete the `*/5 * * * *` schedule.

---

## 🔗 Backup Manual Check Link

If you ever want to verify results manually in a desktop browser:
- **VMOU Declared Results Portal**: [https://online.vmou.ac.in/results.aspx](https://online.vmou.ac.in/results.aspx)
- **Detailed Individual Result Page**: [https://online.vmou.ac.in/result.aspx](https://online.vmou.ac.in/result.aspx)
- **VMOU Main Website**: [https://www.vmou.ac.in](https://www.vmou.ac.in)
- **Student Zone**: [https://online.vmou.ac.in/Admission_Statusway.aspx](https://online.vmou.ac.in/Admission_Statusway.aspx)

---

## 🛠️ Troubleshooting & Common Issues

| Issue | Cause | Resolution |
| :--- | :--- | :--- |
| **Resend Email not arriving** | Using unverified custom domain | Use `onboarding@resend.dev` as `EMAIL_FROM` and set `EMAIL_TO` to your registered Resend email address. |
| **Telegram Error 400: chat not found** | Bot was not started by user | Search for your bot in Telegram and tap **Start** (`/start`) before sending messages. |
| **Dead Man's Switch Tripped** | Cron triggers paused or worker error | Check `npm run tail` for errors; verify that cron trigger is enabled in Cloudflare Dashboard under Worker Triggers. |
| **KV Namespace Error** | Placeholder ID in `wrangler.toml` | Ensure you ran `npx wrangler kv:namespace create RESULTS_KV` and pasted the generated `id` into `wrangler.toml`. |
| **Match never triggered** | Changed session or programme code | Verify the programme row exists on the portal and update `TARGET_PROGRAMME_CODE` / `TARGET_SESSION` in `wrangler.toml`, then re-deploy. |
