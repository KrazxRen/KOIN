> [!IMPORTANT]
> CURRENTLY UNDER CODE REPLACEMENT
> 
> MAY BE UNSTABLE 

# KOIN
> A proof-of-activity based digital currency

KOIN is a mobile-first, installable web app (PWA) where players earn coins every day and send them to each other with QR codes.

## Features

- **Accounts:** sign up / log in, with a "Remember me" option (stays logged in for 90 days, otherwise until the browser closes)
- **Home:** wallet balance and an **Earn** button, once per day, for a random 1.00–10.00 KOINS
- **Transfer:**
  - **Send:** scan the receiver's QR code, enter an amount and your password
  - **Receive:** show your personal QR code
  - **Transaction history:** newest first, e.g. `[07-11-2026] (14:32) : sent 2.00 KOINS to @lisa_na`
- **Me:** profile card, change username, change password, log out, developer card
- **Installable:** works as a home-screen app on Android and iOS

## Tech stack

| Part | Technology |
| --- | --- |
| Server | Node.js + Express |
| Database | PostgreSQL (hosted on Neon) |
| App | One HTML file: plain JavaScript, no framework |
| QR | `qrcode-generator` (making codes), the browser's `BarcodeDetector` or `jsQR` (scanning), both loaded from cdnjs |
| Hosting | Render (free web service) |

## Project structure

```
server.js            API + database logic
package.json
public/
  index.html         the whole app (UI, styles, scripts)
  sw.js              service worker (offline shell, always-fresh pages)
  manifest.json      makes the app installable
  icon-192.png       app icons
  icon-512.png
```

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (from Neon's **Connect** panel) |
| `TZ_OFFSET_MIN` | no | Minutes offset from UTC for the daily reset. Default `330` (India, UTC+5:30) |
| `PORT` | no | Set automatically by the host. Default `3000` |

## Run locally

```bash
npm install
DATABASE_URL="postgresql://..." npm start
```

Then open http://localhost:3000. The tables are created automatically on first start. Camera scanning needs HTTPS, except on `localhost`.

## Deploy

1. Push this repo to GitHub (keep it private).
2. **Neon:** create a free project and copy the connection string.
3. **Render:** New → Web Service → pick this repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `DATABASE_URL`
4. Open the `onrender.com` link on a phone and choose **Install app**.

Pushing a change to GitHub redeploys automatically. Data lives in Neon, so redeploys never erase accounts or coins.

## How it works

- **Balances** are stored as whole hundredths (2.50 KOINS = `250`), so there are no decimal rounding errors.
- **Receive QR codes** contain a permanent random code (`KOIN:<code>`), not the username, so they keep working after a username change.
- **Transfers** run as a single database transaction, with a password check. Coins can't be duplicated or lost.
- **Daily earn** is one atomic database update, so it can only succeed once per day, even with double taps. The day resets at midnight in the `TZ_OFFSET_MIN` timezone.
- **Passwords** are hashed with scrypt and never stored in plain text. Sessions are random tokens stored hashed.
- **Safety limits:** repeated wrong passwords and logins are temporarily blocked. Changing your password logs out your other devices.

## API (all under `/api`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/signup`, `/login`, `/logout` | Accounts and sessions |
| GET | `/me` | Username, balance, receive code, earned-today flag |
| POST | `/earn` | Claim today's reward |
| GET | `/lookup?pid=` | Find a username from a QR code |
| POST | `/send` | Send KOINS (needs password) |
| GET | `/history` | Transaction history |
| POST | `/username`, `/password` | Change account details (need current password) |
| GET | `/healthz` | Health check, outside `/api` |

## Known limits

- Free Render sleeps when idle, so the first load after a quiet period can be slow.
- No transfer limit and no signup limit beyond basic rate limiting, so someone could farm coins with many accounts.
- The QR libraries load from a CDN, so the first visit needs internet.
- The password "show" icon only works right after logging in, because stored passwords can't be turned back into text.

## Changelog

- **1.0.2**: pretty html
- **1.0.1**: changed to Poppins font
- **1.0.0**: first release.

---

Copyright (c) 2026 Krazx Ren

All rights reserved.

Viewing this repository does not grant permission to copy, modify, distribute, or use this source code.
