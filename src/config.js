import fs from 'node:fs';
import path from 'node:path';

export const ROOT_DIR = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

export function parseEnvText(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadDotEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) return;
  const parsed = parseEnvText(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

export function defaultSettings() {
  return {
    contentNiche: process.env.CONTENT_NICHE || 'เรื่องเล่าสั้นๆ สุดลึกลับและน่าทึ่งในประวัติศาสตร์',
    contentLanguage: process.env.CONTENT_LANGUAGE || 'th',
    targetDurationSec: clampInt(process.env.TARGET_DURATION_SEC, 150, 15, 180),
    sceneDurationSec: clampInt(process.env.SCENE_DURATION_SEC, 15, 3, 15),
    resolution: validateResolution(process.env.VIDEO_RESOLUTION || '720p'),
    privacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY',
    dailyPostTime: validateTime(process.env.DAILY_POST_TIME || '09:00'),
    schedulerEnabled: process.env.SCHEDULER_ENABLED === 'true',
    chainFrames: true,
    dryRun: process.env.DRY_RUN === 'true',
  };
}

export function clampInt(val, fallback, min, max) {
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function validateResolution(val) {
  const v = String(val || '720p').toLowerCase();
  return ['360p', '720p', '1080p', '4k'].includes(v) ? v : '720p';
}

export function validateTime(val) {
  return /^\d{2}:\d{2}$/.test(String(val || '')) ? val : '09:00';
}

export function readState() {
  ensureDirs();
  if (!fs.existsSync(STATE_PATH)) {
    return { settings: defaultSettings(), tiktok: null, lastScheduledDate: null, runs: [] };
  }
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return {
    settings: { ...defaultSettings(), ...(raw.settings || {}) },
    tiktok: raw.tiktok || null,
    lastScheduledDate: raw.lastScheduledDate || null,
    runs: Array.isArray(raw.runs) ? raw.runs : [],
  };
}

export function writeState(state) {
  ensureDirs();
  // Atomic write to prevent corrupting state.json on crash
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

export function updateSettings(patch) {
  const state = readState();
  const next = { ...state.settings };
  if (patch.contentNiche !== undefined) next.contentNiche = String(patch.contentNiche).trim().slice(0, 300);
  if (patch.contentLanguage !== undefined) next.contentLanguage = String(patch.contentLanguage).trim().slice(0, 10);
  if (patch.targetDurationSec !== undefined) next.targetDurationSec = clampInt(patch.targetDurationSec, 150, 15, 180);
  if (patch.sceneDurationSec !== undefined) next.sceneDurationSec = clampInt(patch.sceneDurationSec, 15, 3, 15);
  if (patch.resolution !== undefined) next.resolution = validateResolution(patch.resolution);
  if (patch.privacyLevel !== undefined) {
    const allowed = ['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR'];
    if (allowed.includes(patch.privacyLevel)) next.privacyLevel = patch.privacyLevel;
  }
  if (patch.dailyPostTime !== undefined) next.dailyPostTime = validateTime(patch.dailyPostTime);
  if (patch.schedulerEnabled !== undefined) next.schedulerEnabled = Boolean(patch.schedulerEnabled);
  if (patch.chainFrames !== undefined) next.chainFrames = Boolean(patch.chainFrames);
  if (patch.dryRun !== undefined) next.dryRun = Boolean(patch.dryRun);

  state.settings = next;
  writeState(state);
  return next;
}

export function sanitizeError(err) {
  let msg = err instanceof Error ? err.message : String(err || '');
  const secrets = [
    process.env.GEMINI_API_KEY,
    process.env.TIKTOK_CLIENT_SECRET,
    process.env.TIKTOK_CLIENT_KEY,
  ].filter((s) => s && s.length >= 6);
  for (const s of secrets) msg = msg.replaceAll(s, '[REDACTED]');
  msg = msg
    .replace(/AIza[0-9A-Za-z_-]{25,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s]+/gi, '$1[REDACTED]');
  return msg.slice(0, 600);
}
