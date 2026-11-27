import crypto from 'node:crypto';
import fs from 'node:fs';
import { readState, sanitizeError, writeState } from './config.js';

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

// shortcut: in-memory OAuth state map; single-user local server only, move to DB if multi-user
const pendingOAuthStates = new Map();

export function isTikTokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

export function getRedirectUri() {
  const port = process.env.PORT || 3456;
  return process.env.TIKTOK_REDIRECT_URI || `http://localhost:${port}/auth/tiktok/callback`;
}

export function createAuthUrl() {
  if (!isTikTokConfigured()) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set in .env');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingOAuthStates.set(state, Date.now());
  // Expire stale states after 15 minutes
  for (const [k, ts] of pendingOAuthStates) {
    if (Date.now() - ts > 15 * 60 * 1000) pendingOAuthStates.delete(k);
  }

  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: 'user.info.basic,video.publish',
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    state,
  });
  return `${TIKTOK_AUTH_URL}?${params.toString()}`;
}

export async function handleOAuthCallback(code, state) {
  if (!state || !pendingOAuthStates.has(state)) {
    throw new Error('Invalid or expired OAuth state');
  }
  pendingOAuthStates.delete(state);

  const res = await fetch(`${TIKTOK_API_BASE}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`TikTok token exchange failed: ${sanitizeError(data.error_description || JSON.stringify(data))}`);
  }

  const appState = readState();
  appState.tiktok = {
    openId: data.open_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
    refreshExpiresAt: Date.now() + (data.refresh_expires_in || 31536000) * 1000,
    scope: data.scope,
    connectedAt: new Date().toISOString(),
  };
  writeState(appState);
  return appState.tiktok;
}

export async function getValidAccessToken() {
  const appState = readState();
  const tk = appState.tiktok;
  if (!tk?.refreshToken) {
    throw new Error('TikTok account is not connected yet. Connect it in the Web UI first.');
  }

  // Refresh if token expires within 5 minutes
  if (tk.accessToken && tk.expiresAt && Date.now() < tk.expiresAt - 5 * 60 * 1000) {
    return tk.accessToken;
  }

  const res = await fetch(`${TIKTOK_API_BASE}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tk.refreshToken,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`TikTok token refresh failed: ${sanitizeError(data.error_description || JSON.stringify(data))}`);
  }

  appState.tiktok = {
    ...tk,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tk.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };
  writeState(appState);
  return appState.tiktok.accessToken;
}

export async function publishVideoToTikTok(videoPath, { caption, privacyLevel = 'SELF_ONLY', onLog = () => {} }) {
  const token = await getValidAccessToken();
  const stat = fs.statSync(videoPath);
  const videoSize = stat.size;
  if (videoSize === 0) throw new Error('Video file is empty');

  onLog('Querying TikTok creator_info...');
  const infoRes = await fetch(`${TIKTOK_API_BASE}/post/creator_info/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: '{}',
  });
  const infoJson = await infoRes.json();
  if (!infoRes.ok || (infoJson.error?.code && infoJson.error.code !== 'ok')) {
    throw new Error(`TikTok creator_info failed: ${sanitizeError(JSON.stringify(infoJson.error || infoJson))}`);
  }

  // Single-chunk upload for files up to 64MB; multi-chunk 10MB chunks for larger files
  const chunkSize = videoSize <= 64 * 1024 * 1024 ? videoSize : 10 * 1024 * 1024;
  const totalChunkCount = Math.ceil(videoSize / chunkSize);

  onLog(`Initializing TikTok upload (${(videoSize / 1024 / 1024).toFixed(1)} MB, privacy=${privacyLevel})...`);
  const initRes = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: String(caption || '').slice(0, 2200),
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
  });

  const initJson = await initRes.json();
  if (!initRes.ok || (initJson.error?.code && initJson.error.code !== 'ok')) {
    throw new Error(`TikTok publish init failed: ${sanitizeError(JSON.stringify(initJson.error || initJson))}`);
  }

  const { publish_id: publishId, upload_url: uploadUrl } = initJson.data;
  const fileBuf = fs.readFileSync(videoPath);

  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, videoSize) - 1;
    const chunk = fileBuf.subarray(start, end + 1);
    onLog(`Uploading chunk ${i + 1}/${totalChunkCount}...`);

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${videoSize}`,
      },
      body: chunk,
    });
    if (!putRes.ok && putRes.status !== 206) {
      throw new Error(`TikTok chunk upload failed (${putRes.status})`);
    }
  }

  // Poll status up to ~2 minutes
  onLog(`Upload complete (publish_id=${publishId}). Waiting for TikTok processing...`);
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const stRes = await fetch(`${TIKTOK_API_BASE}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const stJson = await stRes.json();
    const status = stJson?.data?.status;
    if (status === 'PUBLISH_COMPLETE') {
      onLog('TikTok publish complete!');
      return { publishId, status };
    }
    if (status === 'FAILED') {
      throw new Error(`TikTok processing failed: ${stJson?.data?.fail_reason || 'unknown'}`);
    }
  }

  return { publishId, status: 'PROCESSING_IN_BACKGROUND' };
}
