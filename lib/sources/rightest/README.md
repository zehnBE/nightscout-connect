# Rightest / Bionime CGM source

Follower-only source for the [Rightest CGM](https://www.rightest.com/) /
Bionime GP series (Taiwan, GP900 / GP922 / GP926 Partner App).

## What this does

Pulls glucose values of a patient who has shared their reading access with you
through the Rightest Partner app and relays them into Nightscout. The
container acts as the "watcher" side: it does NOT send bolus/carb/profile
data, only CGM entries.

## What you need

1. A Rightest **watcher** account (the "follower"), set up via the Partner app
   using an SMS login flow. The initial SMS login must be done ONCE
   out-of-band to obtain a Cognito refresh token; after that the container
   refreshes tokens on its own (30-day Cognito pool TTL).
2. The share link `https://s.rightest.com/XXXXXX` that the patient generated
   in their Rightest app and sent you — OR the patient's internal UUID if
   you already resolved it elsewhere.
3. The sensor must be currently sharing (patient has not revoked access).

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `CONNECT_SOURCE=rightest` | yes | selects this driver |
| `CONNECT_RIGHTEST_REFRESH_TOKEN` | yes* | Cognito RefreshToken from SMS login |
| `CONNECT_RIGHTEST_REFRESH_TOKEN_FILE` | yes* | path to a file holding the token (Docker-secret pattern) |
| `CONNECT_RIGHTEST_SHARE_LINK` | yes** | `https://s.rightest.com/XXXXXX` |
| `CONNECT_RIGHTEST_PATIENT_UID` | yes** | alternative to share link: direct patient UUID |
| `CONNECT_RIGHTEST_REGION` | no | `TW` is the only region wired so far (default `TW`) |
| `CONNECT_RIGHTEST_POLL_MIN` | no | polling interval in minutes, 1..5, default `1` |

\* exactly one of `REFRESH_TOKEN` or `REFRESH_TOKEN_FILE` must be set
\** exactly one of `SHARE_LINK` or `PATIENT_UID` must be set

## How the SMS login works (one-time, out-of-band)

The Rightest API uses AWS Cognito Custom Auth. The flow is:

1. `InitiateAuth` with `AuthFlow=CUSTOM_AUTH` and the phone number in E.164.
2. Cognito returns a `CUSTOM_CHALLENGE` with a `Session`.
3. `RespondToAuthChallenge` with `ChallengeName=CUSTOM_CHALLENGE`,
   `ChallengeResponses.USERNAME`, `ChallengeResponses.ANSWER=<SMS code>`,
   and an `app-id`/`JWT` request-header with an HS256 token signed with a
   daily-rotating secret (see `index.js :: dailySecret()`).
4. On success Cognito returns the `IdToken` / `AccessToken` / `RefreshToken`.
   The RefreshToken is what you store in `CONNECT_RIGHTEST_REFRESH_TOKEN`.

Rightest does NOT rotate the RefreshToken on each `GetTokensFromRefreshToken`
call, so a 30-day pool TTL applies. The container keeps using the same token
until Cognito returns `NotAuthorizedException`, at which point a new SMS
login is required.

## Data endpoints hit on each poll

* `POST /app/api/v1/measure-session/get/latest` — fetch the current session
  (sensor id, start_date, last_consecutive_index, time_zone metadata)
* `POST /app/api/v1/measure-data/get/cgm` — fetch glucose rows from
  `min_index..max_index` (one row = one minute, index-based)

Entries are stamped `startDate + index * 60s` in **UTC** (the Rightest API
returns timestamps in UTC — the `time_zone` field is sensor-location
metadata, not timestamp format).

## Known limitations

* **Taiwan only** so far. Other Rightest regions (JP, EU, MY, ...) likely
  work with a different Cognito pool / API host — PRs welcome.
* **Follower only**. The container does not push treatments/boluses back to
  Rightest.
* The daily `JWT` header secret has to be regenerated server-side (odd/even
  parity switch on the date; see `dailySecret()`).

## Smoke test

```bash
export CONNECT_RIGHTEST_REFRESH_TOKEN="$(cat ./rightest.token)"
export CONNECT_RIGHTEST_SHARE_LINK='https://s.rightest.com/XXXXXX'
node lib/sources/rightest/smoke.js
```

