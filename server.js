const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const CONFIG_FILE = process.env.CONFIG_FILE || '/opt/srt-stats/relays.json';
const STATS_DIR = process.env.STATS_DIR || '/opt/srt-stats';
const PORT = parseInt(process.env.PORT || '8800', 10);

let relays = {};
let processes = {};
let resetPoints = {};
let sessionStarts = {};  // { id: ISO timestamp } — files before this are ignored
let processLogs = {};    // { id: [last 200 stderr lines] }

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) relays = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error('Config load error:', e.message); relays = {}; }
}

function saveConfig() {
  const clean = {};
  for (const [id, r] of Object.entries(relays)) {
    clean[id] = { name: r.name, source: r.source, destination: r.destination, latency: r.latency, passphrase: r.passphrase, autostart: r.autostart, group: r.group };
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2));
}

function isSenderLine(fields) { return (parseFloat(fields[21]) || 0) > 0; }

function detectMode(url) {
  if (!url) return 'caller';
  if (url.includes('mode=')) return null; // already set, don't override
  const match = url.match(/^srt:\/\/([^:/?]*)/);
  if (!match || !match[1] || match[1] === '') return 'listener';
  return 'caller';
}

function getRelayFiles(id) {
  let files = fs.readdirSync(STATS_DIR).filter(f => f.startsWith(id + '_') && f.endsWith('.csv')).sort();
  // Filter by session start if set
  if (sessionStarts[id]) {
    const sessTs = sessionStarts[id].replace(/[:.]/g, '-').slice(0, 19);
    files = files.filter(f => {
      const fTs = f.replace(id + '_', '').replace('.csv', '');
      return fTs >= sessTs;
    });
  }
  return files;
}

// Check if last CSV file is older than 24 hours
function isLastFileStale(id) {
  const allFiles = fs.readdirSync(STATS_DIR).filter(f => f.startsWith(id + '_') && f.endsWith('.csv')).sort();
  if (allFiles.length === 0) return true;
  const lastFile = allFiles[allFiles.length - 1];
  const fTs = lastFile.replace(id + '_', '').replace('.csv', '').replace(/-/g, (m, i) => i < 13 ? '-' : (i === 13 ? 'T' : ':'));
  try {
    const fileTime = new Date(fTs.slice(0, 4) + '-' + fTs.slice(5, 7) + '-' + fTs.slice(8, 10) + 'T' + fTs.slice(11, 13) + ':' + fTs.slice(14, 16) + ':' + fTs.slice(17, 19) + 'Z').getTime();
    return (Date.now() - fileTime) > 24 * 60 * 60 * 1000;
  } catch(e) { return false; }
}

function getCumulativeStats(id) {
  const files = getRelayFiles(id);
  if (files.length === 0) return null;
  let totalLoss = 0, totalRetrans = 0, totalDrop = 0, totalLines = 0;
  for (const f of files) {
    const fp = path.join(STATS_DIR, f);
    try {
      const content = fs.readFileSync(fp, 'utf8').trim().split('\n');
      if (content.length < 3) continue;
      for (let i = content.length - 1; i >= 1; i--) {
        const fields = content[i].split(',');
        if (isSenderLine(fields)) {
          totalLoss += parseInt(fields[12]) || 0;
          totalRetrans += parseInt(fields[14]) || 0;
          totalDrop += parseInt(fields[13]) || 0;
          break;
        }
      }
      totalLines += content.length - 1;
    } catch(e) {}
  }
  return { sndLoss: totalLoss, retrans: totalRetrans, sndDrop: totalDrop, statsLines: totalLines };
}

function getLatestStats(id) {
  const files = getRelayFiles(id);
  if (files.length === 0) return null;
  const latest = path.join(STATS_DIR, files[files.length - 1]);
  try {
    const content = fs.readFileSync(latest, 'utf8').trim().split('\n');
    if (content.length < 3) return null;
    const f1 = content[content.length - 1].split(',');
    const f2 = content[content.length - 2].split(',');
    const sender = isSenderLine(f1) ? f1 : f2;
    const timestamp = f1[0] || '';
    let stale = false;
    try { stale = (Date.now() - new Date(timestamp).getTime()) > 10000; } catch(e) {}

    const cumul = getCumulativeStats(id);
    const rp = resetPoints[id];
    const sinceReset = rp ? {
      sndLoss: Math.max(0, (cumul ? cumul.sndLoss : 0) - (rp.sndLoss || 0)),
      retrans: Math.max(0, (cumul ? cumul.retrans : 0) - (rp.retrans || 0)),
      sndDrop: Math.max(0, (cumul ? cumul.sndDrop : 0) - (rp.sndDrop || 0)),
      statsLines: Math.max(0, (cumul ? cumul.statsLines : 0) - (rp.statsLines || 0))
    } : null;

    return {
      timestamp, stale,
      rtt: stale ? 0 : (parseFloat(sender[7]) || 0),
      sendRate: stale ? 0 : (parseFloat(sender[21]) || 0),
      bandwidth: stale ? 0 : (parseFloat(sender[8]) || 0),
      sndLoss: cumul ? cumul.sndLoss : 0,
      retrans: cumul ? cumul.retrans : 0,
      sndDrop: cumul ? cumul.sndDrop : 0,
      totalSent: parseInt(sender[10]) || 0,
      sinceReset,
      statsFile: files[files.length - 1],
      statsLines: cumul ? cumul.statsLines : 0
    };
  } catch (e) { return null; }
}

function getStatsHistory(id, lines) {
  const files = getRelayFiles(id);
  if (files.length === 0) return [];

  let allLines = []; // { time, sendRate, rtt, sndLoss, retrans, sndDrop, _prevLoss, _prevRetrans }
  const recentFiles = files.slice(-5);

  for (let fi = 0; fi < recentFiles.length; fi++) {
    const fp = path.join(STATS_DIR, recentFiles[fi]);
    try {
      const content = fs.readFileSync(fp, 'utf8').trim().split('\n');
      const senders = content.slice(1).filter(line => isSenderLine(line.split(',')));
      if (senders.length === 0) continue;

      // Insert gap marker between files
      if (allLines.length > 0) {
        const lastTime = allLines[allLines.length - 1].time;
        const nextTime = senders[0].split(',')[0] || '';
        if (lastTime && nextTime) {
          allLines.push({ time: lastTime, sendRate: 0, rtt: 0, dLoss: 0, dRetrans: 0, sndDrop: 0, gap: true });
          allLines.push({ time: nextTime, sendRate: 0, rtt: 0, dLoss: 0, dRetrans: 0, sndDrop: 0, gap: true });
        }
      }

      // Compute per-interval deltas within this file
      let prevLoss = 0, prevRetrans = 0;
      for (let i = 0; i < senders.length; i++) {
        const f = senders[i].split(',');
        const loss = parseInt(f[12]) || 0;
        const retrans = parseInt(f[14]) || 0;
        const dLoss = i === 0 ? 0 : Math.max(0, loss - prevLoss);
        const dRetrans = i === 0 ? 0 : Math.max(0, retrans - prevRetrans);
        prevLoss = loss;
        prevRetrans = retrans;
        allLines.push({
          time: f[0] || '',
          sendRate: parseFloat(f[21]) || 0,
          rtt: parseFloat(f[7]) || 0,
          dLoss,
          dRetrans,
          sndDrop: parseInt(f[13]) || 0
        });
      }
    } catch(e) {}
  }

  // Take last 12000 lines and downsample
  const raw = allLines.slice(-12000);
  const step = Math.max(1, Math.floor(raw.length / lines));
  const sampled = raw.filter((_, i) => i % step === 0).slice(-lines);
  return sampled.map(d => ({
    time: d.time, sendRate: d.sendRate, rtt: d.rtt,
    dLoss: d.dLoss || 0, dRetrans: d.dRetrans || 0,
    gap: d.gap || false
  }));
}

// Get raw CSV lines for log viewer
function getStatsLog(id, lines) {
  const files = getRelayFiles(id);
  if (files.length === 0) return [];
  const latest = path.join(STATS_DIR, files[files.length - 1]);
  try {
    const content = fs.readFileSync(latest, 'utf8').trim().split('\n');
    const senders = content.slice(1).filter(line => isSenderLine(line.split(',')));
    return senders.slice(-lines).map(line => {
      const f = line.split(',');
      return {
        time: (f[0] || '').split('T')[1]?.split('+')[0]?.slice(0, 8) || '',
        sendRate: (parseFloat(f[21]) || 0).toFixed(1),
        rtt: (parseFloat(f[7]) || 0).toFixed(1),
        sndLoss: parseInt(f[12]) || 0,
        retrans: parseInt(f[14]) || 0,
        sndDrop: parseInt(f[13]) || 0,
        bandwidth: (parseFloat(f[8]) || 0).toFixed(1)
      };
    });
  } catch(e) { return []; }
}

function startRelay(id, newSession) {
  if (processes[id] && processes[id].running) return { error: 'Already running' };
  const r = relays[id];
  if (!r) return { error: 'Relay not found' };

  // Session management
  if (newSession || isLastFileStale(id)) {
    sessionStarts[id] = new Date().toISOString();
    delete resetPoints[id];
    console.log(`[${id}] New session started at ${sessionStarts[id]}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const statsFile = path.join(STATS_DIR, `${id}_${ts}.csv`);

  let srcUrl = r.source;
  let dstUrl = r.destination;

  const srcMode = detectMode(srcUrl);
  const dstMode = detectMode(dstUrl);
  if (srcMode && !srcUrl.includes('mode=')) srcUrl += (srcUrl.includes('?') ? '&' : '?') + 'mode=' + srcMode;
  if (dstMode && !dstUrl.includes('mode=')) dstUrl += (dstUrl.includes('?') ? '&' : '?') + 'mode=' + dstMode;
  if (r.latency && !dstUrl.includes('latency=')) dstUrl += `&latency=${r.latency}`;
  if (r.passphrase && !dstUrl.includes('passphrase=')) dstUrl += `&passphrase=${r.passphrase}`;

  const args = [srcUrl, dstUrl, '-s:200', '-pf', 'csv', '-statsout', statsFile, '-fullstats'];
  console.log(`[${id}] Starting: srt-live-transmit ${args.join(' ')}`);

  // Initialize process log buffer
  if (!processLogs[id]) processLogs[id] = [];

  const proc = spawn('srt-live-transmit', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      processLogs[id].push({ time: new Date().toISOString(), msg: line, src: 'stdout' });
      if (processLogs[id].length > 200) processLogs[id].shift();
    }
  });
  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      processLogs[id].push({ time: new Date().toISOString(), msg: line, src: 'stderr' });
      if (processLogs[id].length > 200) processLogs[id].shift();
    }
  });

  proc.on('exit', (code) => {
    const msg = `Process exited with code ${code}`;
    console.log(`[${id}] ${msg}`);
    if (processLogs[id]) {
      processLogs[id].push({ time: new Date().toISOString(), msg, src: 'system' });
      if (processLogs[id].length > 200) processLogs[id].shift();
    }
    if (processes[id]) { processes[id].running = false; processes[id].exitCode = code; processes[id].stoppedAt = new Date().toISOString(); }
    if (relays[id] && processes[id] && !processes[id].manuallyStopped) {
      const restartMsg = 'Auto-restarting in 3s...';
      console.log(`[${id}] ${restartMsg}`);
      if (processLogs[id]) processLogs[id].push({ time: new Date().toISOString(), msg: restartMsg, src: 'system' });
      setTimeout(() => { if (relays[id] && processes[id] && !processes[id].manuallyStopped) startRelay(id, false); }, 3000);
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

// --- API routes ---

app.get('/api/relays', (req, res) => {
  const result = {};
  for (const [id, r] of Object.entries(relays)) {
    const p = processes[id];
    const isRunning = p ? p.running : false;
    result[id] = {
      ...r, running: isRunning,
      pid: p ? p.pid : null,
      startedAt: p ? p.startedAt : null,
      stoppedAt: p ? p.stoppedAt : null,
      resetPoint: resetPoints[id] ? resetPoints[id].time : null,
      sessionStart: sessionStarts[id] || null,
      stats: isRunning ? getLatestStats(id) : null
    };
  }
  res.json(result);
});

app.post('/api/relays', (req, res) => {
  const { name, source, destination, latency, passphrase, autostart, group } = req.body;
  if (!name || !source || !destination) return res.status(400).json({ error: 'name, source, destination required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  if (relays[id]) return res.status(409).json({ error: 'Relay with this name already exists' });
  relays[id] = { name, source, destination, latency: latency || '1200', passphrase: passphrase || '', autostart: autostart || false, group: group || 'default' };
  saveConfig(); res.json({ ok: true, id });
});

app.put('/api/relays/:id', (req, res) => {
  const { id } = req.params;
  if (!relays[id]) return res.status(404).json({ error: 'Not found' });
  for (const f of ['name','source','destination','latency','passphrase','autostart','group']) { if (req.body[f] !== undefined) relays[id][f] = req.body[f]; }
  saveConfig(); res.json({ ok: true });
});

app.delete('/api/relays/:id', (req, res) => {
  const { id } = req.params;
  if (!relays[id]) return res.status(404).json({ error: 'Not found' });
  if (processes[id] && processes[id].running) stopRelay(id);
  delete relays[id]; delete processes[id]; delete resetPoints[id]; delete sessionStarts[id]; delete processLogs[id];
  saveConfig(); res.json({ ok: true });
});

app.post('/api/relays/:id/start', (req, res) => {
  const newSession = req.body.newSession === true;
  res.json(startRelay(req.params.id, newSession));
});
app.post('/api/relays/:id/stop', (req, res) => { res.json(stopRelay(req.params.id)); });

app.post('/api/relays/:id/reset-stats', (req, res) => {
  const cumul = getCumulativeStats(req.params.id);
  resetPoints[req.params.id] = {
    time: new Date().toISOString(),
    sndLoss: cumul ? cumul.sndLoss : 0,
    retrans: cumul ? cumul.retrans : 0,
    sndDrop: cumul ? cumul.sndDrop : 0,
    statsLines: cumul ? cumul.statsLines : 0
  };
  res.json({ ok: true, resetPoint: resetPoints[req.params.id].time });
});

app.post('/api/relays/:id/clear-reset', (req, res) => { delete resetPoints[req.params.id]; res.json({ ok: true }); });
app.post('/api/relays/start-all', (req, res) => { const r = {}; for (const id of Object.keys(relays)) { if (!processes[id] || !processes[id].running) r[id] = startRelay(id, false); } res.json(r); });
app.post('/api/relays/stop-all', (req, res) => { const r = {}; for (const id of Object.keys(relays)) { if (processes[id] && processes[id].running) r[id] = stopRelay(id); } res.json(r); });

app.get('/api/relays/:id/history', (req, res) => {
  res.json(getStatsHistory(req.params.id, parseInt(req.query.lines) || 240));
});

app.get('/api/relays/:id/logs/stats', (req, res) => {
  const lines = Math.min(parseInt(req.query.lines) || 20, 500);
  res.json(getStatsLog(req.params.id, lines));
});

app.get('/api/relays/:id/logs/process', (req, res) => {
  res.json(processLogs[req.params.id] || []);
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR, { recursive: true });

loadConfig();
setTimeout(() => { for (const [id, r] of Object.entries(relays)) { if (r.autostart) { console.log(`[${id}] Auto-starting...`); startRelay(id, false); } } }, 2000);
app.listen(PORT, '0.0.0.0', () => { console.log(`UWW SRT Relay Panel v2.0 running on http://0.0.0.0:${PORT}`); console.log(`Config: ${CONFIG_FILE}, Stats: ${STATS_DIR}`); });
