import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { OUTPUT_DIR, ROOT_DIR, readState, sanitizeError, updateSettings } from './config.js';
import { getActiveRun, runDailyPipeline } from './pipeline.js';
import { startScheduler } from './scheduler.js';
import { createAuthUrl, handleOAuthCallback, isTikTokConfigured } from './tiktok.js';

const PORT = Number.parseInt(process.env.PORT || '3456', 10);
const PUBLIC_HTML = path.join(ROOT_DIR, 'public', 'index.html');

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(PUBLIC_HTML, 'utf8'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const state = readState();
      sendJson(res, 200, {
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
        hasTikTokApp: isTikTokConfigured(),
        tiktokConnected: Boolean(state.tiktok?.refreshToken),
        tiktokConnectedAt: state.tiktok?.connectedAt || null,
        settings: state.settings,
        activeRun: getActiveRun(),
        runs: state.runs,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const updated = updateSettings(body);
      sendJson(res, 200, { ok: true, settings: updated });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJsonBody(req);
      if (getActiveRun()) {
        sendJson(res, 409, { error: 'A run is already in progress' });
        return;
      }
      // Fire asynchronously so UI can poll live logs
      runDailyPipeline({ dryRun: Boolean(body.dryRun) }).catch(() => {});
      sendJson(res, 202, { ok: true, message: 'Run started' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/tiktok') {
      const authUrl = createAuthUrl();
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/tiktok/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        sendJson(res, 400, { error: url.searchParams.get('error_description') || 'Missing code' });
        return;
      }
      await handleOAuthCallback(code, state);
      res.writeHead(302, { Location: '/?tiktok=connected' });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/output/')) {
      const safeName = path.basename(url.pathname.slice('/output/'.length));
      const fullPath = path.join(OUTPUT_DIR, safeName);
      if (!safeName.endsWith('.mp4') || !fs.existsSync(fullPath)) {
        sendJson(res, 404, { error: 'Video not found' });
        return;
      }
      const stat = fs.statSync(fullPath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
      });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: sanitizeError(err) });
  }
});

startScheduler();
server.listen(PORT, () => {
  console.log(`TikTok Omni Auto running at http://localhost:${PORT}`);
});
