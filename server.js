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
let resetPoints = {};

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

function isSenderLine(fields) { return (parseFloat(fields[21]) || 0) > 0; }

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
    const timestamp = f1[0] || '';
    // Check if stats are stale (older than 10 seconds = connection likely down)
    let stale = false;
    try {
      const statsTime = new Date(timestamp).getTime();
      const now = Date.now();
      stale = (now - statsTime) > 10000;
    } catch(e) { stale = false; }
    return {
      timestamp,
      rtt: stale ? 0 : (parseFloat(sender[7]) || 0),
      sendRate: stale ? 0 : (parseFloat(sender[21]) || 0),
      bandwidth: stale ? 0 : (parseFloat(sender[8]) || 0),
      sndLoss: stale ? 0 : (parseInt(sender[12]) || 0),
      retrans: stale ? 0 : (parseInt(sender[14]) || 0),
      sndDrop: stale ? 0 : (parseInt(sender[13]) || 0),
      totalSent: parseInt(sender[10]) || 0,
      stale,
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
    let senderLines = content.slice(1).filter(line => isSenderLine(line.split(',')));
    if (sinceReset && resetPoints[id]) {
      senderLines = senderLines.filter(line => (line.split(',')[0] || '') >= resetPoints[id]);
    }
    // Take last 12000 sender lines (~20 min at ~10 lines/sec) and downsample to 'lines' points
    const raw = senderLines.slice(-12000);
    const step = Math.max(1, Math.floor(raw.length / lines));
    const sampled = raw.filter((_, i) => i % step === 0).slice(-lines);
    return sampled.map(line => {
      const f = line.split(',');
      return { time: f[0]||'', rtt: parseFloat(f[7])||0, sendRate: parseFloat(f[21])||0, sndLoss: parseInt(f[12])||0, retrans: parseInt(f[14])||0, sndDrop: parseInt(f[13])||0 };
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
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  proc.on('exit', (code) => {
    console.log(`[${id}] Exited with code ${code}`);
    if (processes[id]) { processes[id].running = false; processes[id].exitCode = code; processes[id].stoppedAt = new Date().toISOString(); }
    // Always auto-restart unless manually stopped
    if (relays[id] && processes[id] && !processes[id].manuallyStopped) {
      console.log(`[${id}] Auto-restarting in 3s (source or dest dropped)...`);
      setTimeout(() => { if (relays[id] && processes[id] && !processes[id].manuallyStopped) startRelay(id); }, 3000);
    }
  });

  processes[id] = { proc, running: true, startedAt: new Date().toISOString(), statsFile, manuallyStopped: false, pid: proc.pid };
  return { ok: true, pid: proc.pid };
}

function stopRelay(id) {
  if (!processes[id] || !processes[id].proc) return { error: 'Not running' };
  processes[id].manuallyStopped = true;
  processes[id].proc.kill('SIGTERM');
  processes[id].running = false;
  processes[id].stoppedAt = new Date().toISOString();
  return { ok: true };
}

app.get('/api/relays', (req, res) => {
  const result = {};
  for (const [id, r] of Object.entries(relays)) {
    const p = processes[id];
    const isRunning = p ? p.running : false;
    result[id] = { ...r, running: isRunning, pid: p ? p.pid : null, startedAt: p ? p.startedAt : null, stoppedAt: p ? p.stoppedAt : null, resetPoint: resetPoints[id] || null, stats: isRunning ? getLatestStats(id) : null };
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
  for (const f of ['name','source','destination','destMode','latency','passphrase','autostart','group']) { if (req.body[f] !== undefined) relays[id][f] = req.body[f]; }
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
app.post('/api/relays/:id/reset-stats', (req, res) => { resetPoints[req.params.id] = new Date().toISOString(); res.json({ ok: true, resetPoint: resetPoints[req.params.id] }); });
app.post('/api/relays/:id/clear-reset', (req, res) => { delete resetPoints[req.params.id]; res.json({ ok: true }); });
app.post('/api/relays/start-all', (req, res) => { const r = {}; for (const id of Object.keys(relays)) { if (!processes[id] || !processes[id].running) r[id] = startRelay(id); } res.json(r); });
app.post('/api/relays/stop-all', (req, res) => { const r = {}; for (const id of Object.keys(relays)) { if (processes[id] && processes[id].running) r[id] = stopRelay(id); } res.json(r); });
app.get('/api/relays/:id/history', (req, res) => { res.json(getStatsHistory(req.params.id, parseInt(req.query.lines) || 240, req.query.sinceReset === 'true')); });

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.use(express.static(path.join(__dirname, 'public')));

loadConfig();
setTimeout(() => { for (const [id, r] of Object.entries(relays)) { if (r.autostart) { console.log(`[${id}] Auto-starting...`); startRelay(id); } } }, 2000);
app.listen(PORT, '0.0.0.0', () => { console.log(`UWW SRT Relay Panel v1.2 running on http://0.0.0.0:${PORT}`); });
