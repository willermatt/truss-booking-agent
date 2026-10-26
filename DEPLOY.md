# Deploying the Truss booking agent

One small Linux server runs everything: PostgreSQL, the booking API, and the browser. About an hour the
first time. Live submissions stay off until step 7.

## What you need

- An Ubuntu 24.04 server with 2 GB of RAM (any VPS provider), and a DNS name pointing at it (for example
  `booking.trusshi.com`).
- A read-only Spectora API key (https://developer.spectora.com). The agent uses it to check for duplicate
  inspections before it submits; **without it every live booking is blocked**. Dry runs do not need it.
- Spectora's written authorization for this automation (an email is fine). You record a reference to it
  in step 7.

## 1. Install

```
sudo apt update && sudo apt install -y postgresql caddy git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo useradd -m truss && sudo mkdir -p /opt/truss-booking-agent && sudo chown truss /opt/truss-booking-agent
# copy the project into /opt/truss-booking-agent (unzip it there), then:
cd /opt/truss-booking-agent && sudo -u truss npm ci
sudo npx playwright install-deps chromium && sudo -u truss npx playwright install chromium
```

## 2. Database

```
sudo -u postgres createdb truss
sudo -u postgres psql truss -f db/roles.sql
sudo -u postgres psql -c "\password truss_app"        # and the same for truss_owner and truss_migrator
MIGRATOR_DATABASE_URL=postgres://truss_migrator:…@127.0.0.1/truss npm run migrate
```

Do not save the `truss_migrator` or `truss_owner` passwords on the server.

## 3. Settings

```
sudo -u truss npm run api -- new-token      # prints a token (for ChatGPT) and its hash (for the server)
sudo cp deploy/truss.env.example /etc/truss.env && sudo chmod 600 /etc/truss.env && sudo chown truss /etc/truss.env
sudo nano /etc/truss.env                    # truss_app password, Spectora API key, the token hash
```

## 4. Dry run (no submission, no text to you)

Edit `examples/dry-run-request.json`: pick a date that shows an 8:00 AM opening. Then:

```
sudo -u truss bash -c 'set -a; . /etc/truss.env; npm run worker -- dry-run examples/dry-run-request.json'
```

Expected: `"state": "DRY_RUN"` and `spectoraShown` with the price Spectora displayed. The agent selects the
service, enters the address, takes Spectora's square footage and year built if the request has none,
picks the slot, enters the contact, reaches the Review and stops. The "Schedule In Progress" text that
leaving Step 3 normally sends is answered inside the browser and never reaches Spectora. Anything else
comes back as NEEDS_INPUT, UNAVAILABLE or FAILED with the reason.

Add `TRUSS_HEADFUL=1` on a machine with a screen to watch it.

## 5. Start the API with HTTPS

```
sudo cp deploy/truss-api.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now truss-api
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile   # put your DNS name in
sudo systemctl reload caddy
curl https://booking.trusshi.com/v1/health          # {"ok":true}
```

## 6. Connect ChatGPT

```
npm run api -- openapi https://booking.trusshi.com > openapi.json
```

In ChatGPT, create a GPT (keep it private: "Only me"). Under **Actions**, import `openapi.json`; set
Authentication to **API Key**, type **Bearer**, and paste the token from step 3. Instructions for the GPT:

> You book Truss home inspections. Collect the property address (street, unit, city, ZIP), the customer's
> first and last name, phone and email, the service and any add-ons, and the date and time (Arizona time).
> Square footage and year built only if the customer gave them. Never invent details; ask. Call
> startBooking with a new Idempotency-Key, then getBookingStatus with the same key until it is no longer
> running. Report the state in one line: REQUESTED (Spectora has it; Matt confirms), UNAVAILABLE (time not
> offered), NEEDS_INPUT or FAILED with the reason, and the price Spectora showed.

Until step 7, startBooking answers 503 "live_submissions_disabled".

## 7. The designated live test booking (only after you approve it)

1. Confirm Spectora's **Require Confirmation** setting for online scheduling is still on.
2. Fill in `examples/live-test-booking.json` (your own contact details, a real test property, a date with
   an opening).
3. From your own machine, over an SSH tunnel (`ssh -L 5433:127.0.0.1:5432 your-server`), record
   Spectora's authorization and turn submissions on:
   `OWNER_DATABASE_URL=postgres://truss_owner:…@127.0.0.1:5433/truss npm run owner -- enable --approval-ref "Spectora email of <date>" --reason "first test booking" --yes`
4. On the server, once:
   `sudo -u truss bash -c 'set -a; . /etc/truss.env; TRUSS_LIVE_SUBMISSIONS=enabled TRUSS_LOG_CREATE_FIELDS=1 npm run worker -- book examples/live-test-booking.json --key first-test-booking'`
5. Expected: `"state": "REQUESTED"` with a Spectora inspection id. Check it in Spectora, then cancel it.
6. To take bookings from ChatGPT: uncomment `TRUSS_LIVE_SUBMISSIONS=enabled` in `/etc/truss.env` and
   `sudo systemctl restart truss-api`. To stop everything at once: `npm run owner -- disable --reason "…"`.

Limits that always apply: 15 booking jobs and 5 submissions per Arizona day, 2 submissions per hour, one
browser at a time, duplicate check before every submission, no retry after an uncertain submission.
