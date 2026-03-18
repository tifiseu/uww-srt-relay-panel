# UWW SRT Relay Panel

Web-based management panel for SRT stream relays using srt-live-transmit.
Built for UWW (United World Wrestling) live broadcast operations.

## Features
- Manage SRT relay instances via web UI
- Start/stop individual relays or all at once
- Live stats: bitrate, RTT, packet loss, retransmits, drops
- Live charts with history
- Stats reset points for troubleshooting
- CSV stats logging for post-event evidence
- Caller (push) and Listener (pull) destination modes
- Auto-restart on failure, auto-start on boot
- Group filtering and configurable refresh rate

## Stack
- KiloLink Server Pro (bonding)
- srt-live-transmit (relay + stats)
- Node.js + Express (panel)
- Chart.js (graphs)

## Install
```
git clone git@github.com:tifiseu/uww-srt-relay-panel.git /opt/srt-panel
cd /opt/srt-panel && npm install
cp srt-panel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable srt-panel && systemctl start srt-panel
```

## Update
```
cd /opt/srt-panel && git pull && systemctl restart srt-panel
```
