const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const CONFIG_FILE = '/opt/srt-stats/relays.json';
const STATS_DIR = '/opt/srt-stats';
const PORT = 8800;

let relays = {};
let processes = {};
let resetPoints = {}; // id → ISO timestamp

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) relays = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error('Config load error:', e.message); relays = {}; }
}

function saveConfig() {
  const clean = {};
  for (const [id, r] of Object.entries(relays)) {
    clean[id] = { name: r.name, source: r.source, destination: r.destination, destMode: r.destMode || 'caller', latency: r.latency, passphrase: r.passphrase, autostart: r.autostart, group: r.group };
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2));
}

// CSV columns for srt-live-transmit 1.5.3:
// 0:Timepoint 7:msRTT 8:mbpsBandwidth 10:pktSent 12:pktSndLoss
// 13:pktSndDrop 14:pktRetrans 21:mbpsSendRate 38:mbpsRecvRate

function parseSenderLine(fields) {
  return {
    timestamp: fields[0] || '',
    rtt: parseFloat(fields[7]) || 0,
    sendRate: parseFloat(fields[21]) || 0,
    bandwidth: parseFloat(fields[8]) || 0,
    sndLoss: parseInt(fields[12]) || 0,
    retrans: parseInt(fields[14]) || 0,
    sndDrop: parseInt(fields[13]) || 0,
    totalSent: parseInt(fields[10]) || 0,
  };
}

function isSenderLine(fields) {
  return (parseFloat(fields[21]) || 0) > 0;
}

function getLatestStats(id) {
  const files = fs.readdirSync(STATS_DIR).filter(f => f.startsWith(id + '_') && f.endsWith('.csv')).sort();
  if (files.length === 0) return null;
  const latest = path.join(STATS_DIR, files[files.length - 1]);
  try {
    const content = fs.readFileSync(latest, 'utf8').trim().split('\n');
    if (content.length < 3) return null;
    const f1 = content[content.length - 1].split(',');
    const f2 = content[content.length - 2].split(',');
    const sender = isSenderLine(f1) ? f1 : f2;
    const s = parseSenderLine(sender);
    return {
      ...s,
      statsFile: files[files.length - 1],
      statsLines: content.length - 1
    };
  } catch (e) { return null; }
}

function getStatsHistory(id, lines, sinceReset) {
  const files = fs.readdirSync(STATS_DIR).filter(f => f.startsWith(id + '_') && f.endsWith('.csv')).sort();
  if (files.length === 0) return [];
  const latest = path.join(STATS_DIR, files[files.length - 1]);
  try {
    const content = fs.readFileSync(latest, 'utf8').trim().split('\n');
    const dataLines = content.slice(1);
    let senderLines = dataLines.filter(line => {
      const f = line.split(',');
      return isSenderLine(f);
    });

    // If sinceReset, filter by timestamp
    if (sinceReset && resetPoints[id]) {
      const resetTs = resetPoints[id];
      senderLines = senderLines.filter(line => {
        const ts = line.split(',')[0] || '';
        return ts >= resetTs;
      });
    }

    return senderLines.slice(-lines).map(line => {
      const f = line.split(',');
      return {
        time: f[0] || '',
        rtt: parseFloat(f[7]) || 0,
        sendRate: parseFloat(f[21]) || 0,
        sndLoss: parseInt(f[12]) || 0,
        retrans: parseInt(f[14]) || 0,
        sndDrop: parseInt(f[13]) || 0,
      };
    });
  } catch (e) { return []; }
}

function startRelay(id) {
  if (processes[id] && processes[id].running) return { error: 'Already running' };
  const r = relays[id];
  if (!r) return { error: 'Relay not found' };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const statsFile = path.join(STATS_DIR, `${id}_${ts}.csv`);

  let srcUrl = r.source;
  let dstUrl = r.destination;
  const destMode = r.destMode || 'caller';

  if (!srcUrl.includes('mode=')) srcUrl += (srcUrl.includes('?') ? '&' : '?') + 'mode=caller';
  if (!dstUrl.includes('mode=')) dstUrl += (dstUrl.includes('?') ? '&' : '?') + 'mode=' + destMode;
  if (r.latency && !dstUrl.includes('latency=')) dstUrl += `&latency=${r.latency}`;
  if (r.passphrase && !dstUrl.includes('passphrase=')) dstUrl += `&passphrase=${r.passphrase}`;

  const args = [srcUrl, dstUrl, '-s:200', '-pf', 'csv', '-statsout', statsFile, '-fullstats'];
  console.log(`[${id}] Starting: srt-live-transmit ${args.join(' ')}`);

  const proc = spawn('srt-live-transmit', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let lastOutput = '';
  proc.stdout.on('data', d => { lastOutput = d.toString().trim(); });
  proc.stderr.on('data', d => { lastOutput = d.toString().trim(); });

  proc.on('exit', (code) => {
    console.log(`[${id}] Exited with code ${code}`);
    if (processes[id]) { processes[id].running = false; processes[id].exitCode = code; processes[id].stoppedAt = new Date().toISOString(); }
    if (relays[id] && relays[id].autostart && processes[id] && !processes[id].manuallyStopped) {
      console.log(`[${id}] Auto-restarting in 3s...`);
      setTimeout(() => startRelay(id), 3000);
    }
  });

  processes[id] = { proc, running: true, startedAt: new Date().toISOString(), statsFile, manuallyStopped: false, pid: proc.pid };
  delete resetPoints[id];
  return { ok: true, pid: proc.pid };
}

function stopRelay(id) {
  if (!processes[id] || !processes[id].proc) return { error: 'Not running' };
  processes[id].manuallyStopped = true;
  processes[id].proc.kill('SIGTERM');
  return { ok: true };
}

// API Routes
app.get('/api/relays', (req, res) => {
  const result = {};
  for (const [id, r] of Object.entries(relays)) {
    const p = processes[id];
    result[id] = { ...r, running: p ? p.running : false, pid: p ? p.pid : null, startedAt: p ? p.startedAt : null, stoppedAt: p ? p.stoppedAt : null, resetPoint: resetPoints[id] || null, stats: getLatestStats(id) };
  }
  res.json(result);
});

app.post('/api/relays', (req, res) => {
  const { name, source, destination, destMode, latency, passphrase, autostart, group } = req.body;
  if (!name || !source || !destination) return res.status(400).json({ error: 'name, source, destination required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  if (relays[id]) return res.status(409).json({ error: 'Relay with this name already exists' });
  relays[id] = { name, source, destination, destMode: destMode || 'caller', latency: latency || '1200', passphrase: passphrase || '', autostart: autostart || false, group: group || 'default' };
  saveConfig(); res.json({ ok: true, id });
});

app.put('/api/relays/:id', (req, res) => {
  const { id } = req.params;
  if (!relays[id]) return res.status(404).json({ error: 'Not found' });
  const fields = ['name', 'source', 'destination', 'destMode', 'latency', 'passphrase', 'autostart', 'group'];
  for (const f of fields) { if (req.body[f] !== undefined) relays[id][f] = req.body[f]; }
  saveConfig(); res.json({ ok: true });
});

app.delete('/api/relays/:id', (req, res) => {
  const { id } = req.params;
  if (!relays[id]) return res.status(404).json({ error: 'Not found' });
  if (processes[id] && processes[id].running) stopRelay(id);
  delete relays[id]; delete processes[id]; delete resetPoints[id];
  saveConfig(); res.json({ ok: true });
});

app.post('/api/relays/:id/start', (req, res) => { res.json(startRelay(req.params.id)); });
app.post('/api/relays/:id/stop', (req, res) => { res.json(stopRelay(req.params.id)); });

app.post('/api/relays/:id/reset-stats', (req, res) => {
  const { id } = req.params;
  if (!relays[id]) return res.status(404).json({ error: 'Not found' });
  resetPoints[id] = new Date().toISOString();
  res.json({ ok: true, resetPoint: resetPoints[id] });
});

app.post('/api/relays/:id/clear-reset', (req, res) => {
  const { id } = req.params;
  delete resetPoints[id];
  res.json({ ok: true });
});

app.post('/api/relays/start-all', (req, res) => { const r = {}; for (const id of Object.keys(relays)) { if (!processes[id] || !processes[id].running) r[id] = startRelay(id); } res.json(r); });
app.post('/api/relays/stop-all', (req, res) => { const r = {}; for (const id of Object.keys(relays)) { if (processes[id] && processes[id].running) r[id] = stopRelay(id); } res.json(r); });

app.get('/api/relays/:id/history', (req, res) => {
  const lines = parseInt(req.query.lines) || 240;
  const sinceReset = req.query.sinceReset === 'true';
  res.json(getStatsHistory(req.params.id, lines, sinceReset));
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.use(express.static(path.join(__dirname, 'public')));

loadConfig();
setTimeout(() => { for (const [id, r] of Object.entries(relays)) { if (r.autostart) { console.log(`[${id}] Auto-starting...`); startRelay(id); } } }, 2000);
app.listen(PORT, '0.0.0.0', () => { console.log(`UWW SRT Relay Panel v1.1 running on http://0.0.0.0:${PORT}`); });
