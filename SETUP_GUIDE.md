# WA Monitor — Setup Guide for Mayank
## Complete step-by-step deployment instructions

---

## WHAT THIS DOES
- Monitors all your WhatsApp client & internal groups via your second number
- Sends instant alerts to your MAIN number when:
  - Client sends a critical message (complaint, escalation, salary issue, site unmanned)
  - You are tagged anywhere
  - A client message goes unanswered for 2+ hours
- Sends you a 7 PM evening digest with:
  - All unresolved client issues
  - Internal asks/tasks with no response

---

## PREREQUISITES (have these ready)
- [ ] Second Jio SIM (active)
- [ ] Anthropic API key from console.anthropic.com
- [ ] A Facebook/Meta account

---

## STAGE 1 — Meta WhatsApp Cloud API Setup

### Step 1: Create Meta App
1. Go to https://developers.facebook.com
2. Click "My Apps" → "Create App"
3. Choose "Business" → Next
4. App name: "WA Monitor Tenon" → Create
5. In your app dashboard → "Add a Product" → Find WhatsApp → click "Set Up"

### Step 2: Register your second SIM number
1. Inside WhatsApp section → "Getting Started"
2. Under "Step 5: Add a phone number" → click "Add phone number"
3. Enter your second Jio number
4. Verify with OTP

### Step 3: Get your credentials
From the "API Setup" page, copy these 3 things:
- **Phone Number ID** (looks like: 123456789012345)
- **WhatsApp Business Account ID**
- **Temporary access token** (we'll make it permanent next)

### Step 4: Get a permanent access token
1. Go to https://developers.facebook.com/tools/explorer
2. Select your app from dropdown
3. Click "Generate Access Token"
4. Select permissions: whatsapp_business_messaging, whatsapp_business_management
5. Copy the token — this is your WA_TOKEN

---

## STAGE 2 — Deploy the Server (Railway.app — Free)

### Step 1: Create Railway account
1. Go to https://railway.app
2. Sign up with GitHub (create GitHub account if needed — it's free)

### Step 2: Deploy the code
1. Go to https://github.com → Create new repository → Name: "wa-monitor" → Public → Create
2. Upload all 3 files (index.js, package.json, .env.template) to the repo
3. In Railway → "New Project" → "Deploy from GitHub repo" → select wa-monitor
4. Railway will auto-deploy

### Step 3: Add environment variables in Railway
1. Click your project → "Variables" tab
2. Add these one by one:
   - WA_TOKEN = (your token from Meta)
   - PHONE_NUMBER_ID = (from Meta)
   - MY_MAIN_NUMBER = 91XXXXXXXXXX (your personal WA number)
   - ANTHROPIC_KEY = (from console.anthropic.com)
3. Railway will auto-restart with new variables

### Step 4: Get your server URL
- Click your project → "Settings" → "Domains"
- Generate domain → copy it (looks like: wa-monitor-production.up.railway.app)

---

## STAGE 3 — Connect Meta Webhook to Your Server

### Step 1: Set webhook in Meta
1. Go back to Meta Developer Dashboard → Your App → WhatsApp → Configuration
2. Under "Webhook" → click "Edit"
3. Callback URL: https://YOUR-RAILWAY-URL/webhook
4. Verify token: mayank_wa_monitor_2026
5. Click "Verify and Save"
6. Subscribe to: messages

### Step 2: Find your group IDs
1. Send a test message to one of your client groups from the second number
2. Go to Railway → your project → "Logs"
3. You'll see something like: "Message from XYZ in 120363XXXXXXXXX@g.us"
4. That long number is your group ID

### Step 3: Add group IDs to the code
In index.js, find GROUP_CONFIG and add your group IDs:
```
client_groups: [
  "120363XXXXXXXXX@g.us",  // Nykaa group
  "120363XXXXXXXXX@g.us",  // Ujjivan group
  // ... all 100 client groups
],
internal_groups: [
  "120363XXXXXXXXX@g.us",  // Pan Ops
],
```
Commit the change to GitHub → Railway auto-redeploys

---

## STAGE 4 — Test It

1. From another phone, send a test message to one of the groups where your second number is added
2. Type: "Salary still not received, no one responding since morning"
3. Within 30 seconds you should get an alert on your MAIN number
4. Check Railway logs for any errors

---

## ONGOING MAINTENANCE

- Add new client groups: just add their group ID to GROUP_CONFIG
- Add new team members: add their name to TENON_TEAM_IDENTIFIERS
- Change alert timing: edit NO_RESPONSE_ALERT_HOURS in CONFIG
- Change digest time: edit DIGEST_HOUR in CONFIG (24h format)

---

## COST SUMMARY
| Item | Cost |
|------|------|
| Meta WhatsApp Cloud API | Free |
| Railway server | Free (within limits) |
| Anthropic Claude API | ~₹500-1500/month |
| Second Jio SIM | ₹50-100 one time |
| **TOTAL** | **~₹500-1500/month** |

---

## SUPPORT
If anything doesn't work, come back to Claude with the error message from Railway logs.
Share the exact error text and Claude will fix the code immediately.
