# UWW SRT Relay Panel

Web-based management panel for SRT relay instances using `srt-live-transmit`. Built for United World Wrestling live broadcast operations.

**Features:**
- Add/edit/delete SRT relays via web UI
- Caller (push) and Listener (pull) destination modes
- Start/stop individual or all relays with auto-reconnect
- Live stats: bitrate, RTT, packet loss, retransmits, drops
- Live Chart.js graphs with ~20 min history (downsampled)
- Retrying relay detection with amber alerts and scroll-to
- Group filtering, configurable refresh, CSV stats logging

## Architecture

```
KiloLink Server Pro (bonding encoder)
    ↓ SRT localhost ports (30100-30104)
srt-live-transmit (managed by this panel)
    ↓ SRT push/pull
Destinations: TV takers, Brightcove, Flo, EVS
```

## Deployment Options

### Option A: Bare-metal (current production — uwwkilo-fra1)

```bash
# On Ubuntu 24.04 with Node.js 20+ and srt-tools installed
cd /opt/srt-panel
npm install --production
node server.js
# Or use the systemd service: systemctl start srt-panel
```

### Option B: Docker via Coolify (backup/new servers)

See the step-by-step guide below.

---

## Coolify Deployment Guide (step by step)

### Prerequisites

- A Linux server with Coolify installed (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`)
- Server firewall allows inbound: **8800** (web UI), **30000-30300** (SRT ports), **50000-50099** (KiloLink bonding)
- GitHub deploy key or Coolify GitHub App configured for repo access

### Step 1: Configure GitHub access in Coolify

1. Open Coolify dashboard → **Settings** → **Keys & Tokens**
2. Add a new SSH key (deploy key) — or connect your GitHub App
3. Add the public key to this GitHub repo: **Settings → Deploy keys → Add deploy key** (read-only is fine)

### Step 2: Create the project in Coolify

1. In Coolify dashboard → **Projects** → **+ Create New Project**
2. Name it `UWW Broadcast` (or similar)
3. Click into the project → **+ Create New Resource**

### Step 3: Add the application

1. Choose **Private Repository (via Deploy Key)** or **GitHub App** depending on Step 1
2. Repository URL: `git@github.com:tifiseu/uww-srt-relay-panel.git`
3. Branch: `main`
4. **Build Pack**: Change from Nixpacks to **Docker Compose**
5. Docker Compose location: `/docker-compose.yml`
6. **Enable "Raw Compose Deployment"** toggle (in Advanced settings)
   - This is critical — it lets `network_mode: host` work without Coolify interference

### Step 4: Deploy

1. Click **Deploy**
2. Coolify will:
   - Clone the repo
   - Build the Docker image (installs Ubuntu 24.04 + Node.js + srt-tools)
   - Start the container with host networking
3. First build takes ~2-3 minutes. Subsequent builds use cached layers (~30 seconds)

### Step 5: Verify

1. Open `http://YOUR_SERVER_IP:8800` — you should see the SRT Relay Panel
2. The `/data` Docker volume stores `relays.json` and CSV stats — persists across restarts/rebuilds

### Step 6: Configure KiloLink

Install KiloLink Server Pro on the same server (separate Docker container), same as the production setup:

```bash
docker run -d --name KLNKSVR-pro --network host \
  -v klnk-data:/opt/kilolink \
  --restart unless-stopped \
  kiloview/kilolink-server-pro:latest
```

KiloLink web UI: `http://YOUR_SERVER_IP:80`, bonding port: `50000`.

---

## Updating the application

### Via Coolify (recommended)

1. Push changes to `main` branch on GitHub
2. In Coolify → click **Redeploy** (or enable auto-deploy webhook)
3. Coolify rebuilds only changed layers and restarts the container
4. Your relay config (`relays.json`) is safe in the `/data` volume — it survives rebuilds

### Via manual docker compose

```bash
ssh root@YOUR_SERVER_IP
cd /path/to/uww-srt-relay-panel
git pull
docker compose up -d --build
```

### What triggers a full rebuild vs. quick rebuild

| Change | Rebuild time | Why |
|--------|-------------|-----|
| `server.js`, `public/index.html` | ~30 seconds | Only top layers change (cached apt + npm) |
| `package.json` (new dependency) | ~1 minute | npm install reruns, but OS layer cached |
| `Dockerfile` (OS/srt change) | ~2-3 minutes | Full rebuild from base |

---

## Updating srt-live-transmit

The container uses Ubuntu 24.04's `srt-tools` package (currently provides srt-live-transmit 1.5.3).

**Security/patch updates:** Rebuild the image with `--no-cache`:
```bash
docker compose build --no-cache
docker compose up -d
```
Or in Coolify: toggle "Use Build Cache" off → Redeploy → toggle back on.

**Major version upgrade:** If Ubuntu's package is too old, edit the `Dockerfile` to compile from source:
```dockerfile
# Replace the srt-tools apt line with:
RUN apt-get install -y build-essential cmake libssl-dev git && \
    git clone --branch v1.6.0 https://github.com/Haivision/srt.git /tmp/srt && \
    cd /tmp/srt && mkdir build && cd build && cmake .. && make -j$(nproc) && make install && \
    ldconfig && rm -rf /tmp/srt
```

---

## Backup & restore

### Relay configuration
```bash
# Backup (from server)
docker cp uww-srt-panel:/data/relays.json ./relays-backup.json

# Restore
docker cp ./relays-backup.json uww-srt-panel:/data/relays.json
docker restart uww-srt-panel
```

### Full data volume backup
```bash
docker run --rm -v uww-srt-relay-panel_srt-data:/data -v $(pwd):/backup \
  ubuntu tar czf /backup/srt-panel-data-$(date +%F).tar.gz -C /data .
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_FILE` | `/data/relays.json` | Path to relay configuration file |
| `STATS_DIR` | `/data` | Directory for CSV stats files |
| `PORT` | `8800` | Web UI port |

---

## File structure

```
├── Dockerfile              # Container image definition
├── docker-compose.yml      # Coolify / standalone Docker deployment
├── .dockerignore           # Files excluded from Docker build
├── package.json            # Node.js dependencies
├── server.js               # API + relay process management
├── public/
│   ├── index.html          # Frontend with live charts
│   └── favicon.svg         # Purple circle favicon
├── srt-panel.service       # Systemd unit (bare-metal only)
└── README.md               # This file
```

## Ports used

| Port | Protocol | Purpose |
|------|----------|---------|
| 8800 | TCP | Web UI |
| 80 | TCP | KiloLink Server Pro web UI |
| 50000-50099 | TCP+UDP | KiloLink bonding (encoder ingest) |
| 30000-30099 | TCP+UDP | Reserved — KiloLink SRT outputs |
| 30100-30199 | TCP+UDP | KiloLink → Panel source ports |
| 30200-30300 | TCP+UDP | Listener-mode relay outputs |

## License

Proprietary — United World Wrestling broadcast operations.
