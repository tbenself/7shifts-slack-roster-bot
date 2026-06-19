# 7shifts Slack Roster Bot

A small Slack DM bot that answers "who's working?" from 7shifts schedules.

It can run as either:

- a Cloudflare Worker for production
- a tiny local Node HTTP server for development and smoke testing

Example Slack DMs:

- `who's working`
- `who is working at Downtown`
- `downtown`
- `riverside tomorrow`
- `events today`
- `usage`

By default, a bare location returns who is working right now. A location followed by `yesterday`, `today`, or `tomorrow` returns the full schedule for that local calendar day.

The bot enriches shifts with employee, role, location, and department/area/station-style labels when 7shifts returns them. Replies intentionally include only names, roles, schedule labels, locations, and shift times.

DM `usage` or `stats` to see aggregate weekly bot usage when Cloudflare KV is configured. Usage tracking stores counts by week, request mode, requested location alias, and normalized unmatched terms so common typos or missing aliases can be added later. It does not store staff schedules, Slack names, Slack user IDs, or full raw message text.

## 7shifts API Basis

The bot uses the 7shifts v2 API:

- API requests use `Authorization: Bearer ...`.
- Some 7shifts tokens may also require an `x-company-guid` header. If your token works without it, leave `SEVENSHIFTS_COMPANY_GUID` blank. If 7shifts returns a GUID/header error, add it.
- Current shifts are queried from `GET https://api.7shifts.com/v2/company/{company_id}/shifts` with a recent `start` window, then filtered locally to shifts where `start <= now <= end`.
- Full-day schedules use a local-day `start` window for `yesterday`, `today`, or `tomorrow`, then sort shifts chronologically.
- The Worker deliberately avoids the `end[gte]` shift filter because some 7shifts installations have returned slow or timed-out responses with that filter.
- Users, roles, departments, and locations are read from `/users`, `/roles`, `/departments`, and `/locations` for display names.

Your 7shifts token should be able to read:

```text
shifts:read users:read locations:read roles:read departments:read
```

## Slack App Setup

Create a Slack app and configure:

1. OAuth scopes:
   - `chat:write`
   - `im:history`
   - `im:read`
2. Event subscriptions:
   - Request URL: `https://YOUR_HOST/slack/events`
   - Bot event: `message.im`
3. Install the app to your Slack workspace.
4. Copy the bot token and signing secret into your runtime environment.

The service responds immediately to Slack and posts the roster asynchronously, which keeps Slack retries calm.

## Local Run

```bash
cp .env.example .env
$EDITOR .env
npm start
```

Minimum 7shifts values:

```text
SEVENSHIFTS_ACCESS_TOKEN=...
SEVENSHIFTS_COMPANY_ID=...
```

Optional if 7shifts requires it:

```text
SEVENSHIFTS_COMPANY_GUID=...
```

Health check:

```bash
curl http://localhost:3000/healthz
```

Run tests:

```bash
npm test
```

## Cloudflare Workers Deploy

The Worker entrypoint is `src/worker.js`.

1. Copy the Worker template:

```bash
cp wrangler.toml.example wrangler.toml
```

2. Edit `wrangler.toml`:

- choose your Worker name
- set `TIME_ZONE`
- customize `LOCATION_ALIASES_JSON`
- optionally add a `USAGE_KV` namespace binding

3. Log in to Cloudflare:

```bash
npx wrangler login
```

4. Set encrypted Worker secrets:

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_ALLOWED_TEAM_IDS
npx wrangler secret put SEVENSHIFTS_ACCESS_TOKEN
npx wrangler secret put SEVENSHIFTS_COMPANY_ID
```

If 7shifts rejects API calls without a company GUID header:

```bash
npx wrangler secret put SEVENSHIFTS_COMPANY_GUID
```

5. Optional: enable aggregate usage stats:

```bash
npx wrangler kv namespace create USAGE_KV
```

Paste the returned namespace ID into `wrangler.toml` under the commented `[[kv_namespaces]]` block.

6. Deploy:

```bash
npm run deploy:worker
```

Use the deployed Worker URL in Slack:

```text
https://YOUR_WORKER.YOUR_WORKERS_SUBDOMAIN.workers.dev/slack/events
```

To run a local Worker preview:

```bash
npm run dev:worker
```

Do not put production secrets in `wrangler.toml`; use Worker secrets. Non-secret defaults such as `TIME_ZONE`, `NAME_FORMAT`, `SEVENSHIFTS_API_VERSION`, and location aliases can live in `wrangler.toml`.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | yes | Used to verify Slack request signatures. |
| `SLACK_BOT_TOKEN` | yes | Bot token used for `chat.postMessage`. |
| `SLACK_ALLOWED_TEAM_IDS` | no | Recommended. Comma-separated Slack workspace IDs allowed to use the bot. |
| `SEVENSHIFTS_ACCESS_TOKEN` | yes | Static 7shifts bearer token. |
| `SEVENSHIFTS_API_KEY` | no | Supported alias for the static 7shifts bearer token. |
| `SEVENSHIFTS_COMPANY_ID` | yes | Numeric company ID used in 7shifts endpoint paths. |
| `SEVENSHIFTS_COMPANY_GUID` | maybe | Optional for static-token installs; add if 7shifts rejects calls without `x-company-guid`. Required for OAuth fallback. |
| `SEVENSHIFTS_API_VERSION` | no | Defaults to `2025-03-01`; override if your account pins another API version. |
| `LOCATION_ALIASES_JSON` | no | Maps Slack-friendly names to 7shifts location IDs or names. |
| `NAME_FORMAT` | no | `first_last_initial` default, or `full`, or `first`. |
| `TIME_ZONE` | no | Defaults to `America/New_York`. |
| `ALLOWED_CHANNEL_IDS` | no | Optional allow-list for non-DM use later. |
| `USAGE_KV` | no | Cloudflare KV binding used for weekly aggregate usage stats. |
| `USAGE_ALLOWED_USER_IDS` | no | Optional comma-separated Slack user IDs allowed to request `usage`/`stats`; if blank, any allowed workspace user can request aggregate stats. |
| `SEVENSHIFTS_CLIENT_ID` | no | OAuth fallback only. |
| `SEVENSHIFTS_CLIENT_SECRET` | no | OAuth fallback only. |
| `SEVENSHIFTS_SCOPES` | no | OAuth fallback only; defaults to read-only roster scopes. |

## Security Notes

- The Slack endpoint must be public so Slack can reach it, but it is not a public roster API.
- Every Slack request is verified with the app signing secret before work is done.
- Set `SLACK_ALLOWED_TEAM_IDS` in production so signed requests from other workspaces are ignored before any 7shifts lookup.
- Keep tokens in your runtime's secret manager. Do not commit `.env`, `wrangler.toml`, or Wrangler cache files.

## License

MIT
