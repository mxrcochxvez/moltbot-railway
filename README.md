# Moltbot on Railway

A modernized, one-click deployable version of Moltbot (formerly Clawdbot) for
[Railway](https://railway.app).

This project wraps the official Moltbot agent with a custom Setup UI and a
secure configuration flow.

## Features

- **Latest Moltbot**: Builds directly from the `v2026.1.25` tag for stability.
- **Premium Setup UI**: deeply integrated setup wizard for configuring secrets.
- **Web Terminal**: Integrated `ttyd` terminal accessible at `/terminal` for
  full shell access.
- **Linuxbrew**: Pre-installed Homebrew for easy package management.
- **Secure**:
  - Protected Setup Page (via `SETUP_PASSWORD`).
  - Automatic Gateway Token generation.

## How it Works

This project runs a **Node.js Wrapper** (`src/server.js`) that acts as the main
entry point (Port 8080).

1. **Proxy Architecture**:
   - **`/terminal`**: Proxies to `ttyd` (running internally on port 7681).
   - **`/` (Root)**: Proxies all other traffic to **Moltbot** (running
     internally on port 3000).
   - _This ensures the Moltbot UI is fully exposed via your public Railway URL._

2. **Setup Mode**:
   - If no configuration is found in `/data`, the wrapper serves the Setup
     Wizard.
   - Once configured, it saves credentials to `/data/.env` and restarts into
     Proxy Mode.

## Deployment

1. Fork/Clone this repository.
2. Create a new project on Railway from GitHub.
3. Add the following **Environment Variable**:
   - `SETUP_PASSWORD`: (Required) A password to protect your setup page.
4. Deploy!
5. Visit your Railway URL (e.g., `https://web-production-xxxx.up.railway.app`)
   and enter your password to start setup.

## Terminal Usage

Access the web terminal at:

```
https://<your-app-url>/terminal
```

Default user is `railway`. You can use `brew` to install tools:

```bash
brew install htop
```
