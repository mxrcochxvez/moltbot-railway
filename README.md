# OpenClaw on Railway

Deploy [OpenClaw](https://github.com/openclaw/openclaw) on
[Railway](https://railway.app) with a streamlined setup UI.

## Quick Start

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/mxrcochxvez/moltbot-railway)

## Features

- **Latest OpenClaw**: Builds from source for latest features
- **Setup UI**: Web-based wizard for configuring LLM providers and chat
  platforms
- **Telegram & Discord**: Built-in support with device pairing
- **Persistent Config**: Uses Railway volumes for data persistence

## Environment Variables

| Variable         | Required | Description                                        |
| ---------------- | -------- | -------------------------------------------------- |
| `SETUP_PASSWORD` | Yes      | Password to protect setup page (username: `admin`) |
| `BRAVE_API_KEY`  | No       | For Brave Search integration                       |

## Data Persistence

**Important**: Attach a Railway Volume mounted at `/data` to persist your
configuration across deploys.

1. Railway Dashboard → Your Service → **Volumes**
2. Click **Add Volume**
3. Mount path: `/data`
4. Deploy

Without a volume, you'll need to re-run setup after each deploy.

## How It Works

1. **Setup Mode**: If no config exists, shows the setup wizard at `/`
2. **Running Mode**: Once configured, proxies to OpenClaw gateway at `/openclaw` (legacy `/clawdbot` still works)

The wrapper (`src/server.js`) manages:

- Setup wizard and API endpoints
- OpenClaw gateway lifecycle
- Telegram/Discord channel configuration
- Device pairing flow

## Post-Setup

After setup completes:

1. **OpenClaw UI**: Visit `/openclaw` for the chat interface (legacy `/clawdbot` still works)
2. **Device Pairing**: Message your bot on Telegram/Discord, get the pairing
   code, enter it in the setup page

## Running CLI Commands

For CLI access (running `openclaw config set ...` etc):

## Config migration

OpenClaw stores config in `/data/.openclaw/openclaw.json`. On startup, the wrapper
copies legacy Moltbot/ClawdBot state (such as `/data/.clawdbot` or `/data/.moltbot`)
into `/data/.openclaw` when the new directory is empty, so existing Railway volumes
keep working. Legacy config files like `moltbot.json` are copied to
`openclaw.json` if needed. Legacy gateway tokens are reused if present.

- Use Railway's **Shell** tab in the dashboard
- Or SSH into the container

## Local Development

```bash
docker-compose up --build
```

Setup page available at `http://localhost:8080` (password: `admin`)

## Troubleshooting

**Bot not responding after setup?**

- Check Railway logs for gateway errors
- Ensure you completed device pairing (Telegram/Discord require it)

**Asked to re-setup after redeploy?**

- Attach a volume at `/data` (see Data Persistence above)

**Permission errors?**

- The Dockerfile runs as root to avoid volume permission issues
