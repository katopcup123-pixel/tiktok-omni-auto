import fs from 'node:fs';
import path from 'node:path';
import { clampInt, sanitizeError, validateResolution } from './config.js';

const API_BASE = 'https://generativelanguage.googleapis.com';
const PLANNER_MODEL = 'gemini-2.5-flash';
const VIDEO_MODEL = 'gemini-omni-1.2-flash';

function requireApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set in .env');
  return key;
}

export function computeScenePlanCount(targetDurationSec, sceneDurationSec) {
  const dur = clampInt(sceneDurationSec, 15, 3, 15);
  const total = clampInt(targetDurationSec, 150, 15, 180);
  const count = Math.max(1, Math.round(total / dur));
  return { count, sceneDurationSec: dur, estimatedTotalSec: count * dur };
}

export async function planEpisode(settings, recentTitles = []) {
  const apiKey = requireApiKey();
  const { count, sceneDurationSec } = computeScenePlanCount(
    settings.targetDurationSec,
    settings.sceneDurationSec
  );

  const avoidList = recentTitles.length
    ? `Avoid repeating these recent topics: ${recentTitles.slice(0, 10).join(', ')}.`
    : '';

  const prompt = [
    `Create a ${count}-scene vertical TikTok video script (${count * sceneDurationSec} seconds total).`,
    `Niche/Theme: ${settings.contentNiche}`,
    `Caption & spoken language: ${settings.contentLanguage}`,
    avoidList,
    `Rules:`,
    `- Exactly ${count} scenes, each ${sceneDurationSec} seconds long.`,
    `- Scene 1 MUST have a strong 3-second visual hook.`,
    `- Each scene "prompt" must be detailed English visual + camera + audio/voiceover direction for Gemini Omni 1.2 Flash (9:16 vertical cinematic framing, cohesive character/style across scenes, including spoken narration in ${settings.contentLanguage} or fitting sound design).`,
    `- Return strict JSON matching: { "title": string, "caption": string, "hashtags": string[], "scenes": [{ "index": number, "durationSec": number, "prompt": string }] }`,
  ].join('\n');

  const res = await fetch(
    `${API_BASE}/v1beta/models/${PLANNER_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.9,
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini planner error (${res.status}): ${sanitizeError(await res.text())}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini planner returned empty response');

  const plan = JSON.parse(text);
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    throw new Error('Gemini planner returned no scenes');
  }

  plan.scenes = plan.scenes.slice(0, count).map((s, idx) => ({
    index: idx + 1,
    durationSec: clampInt(s.durationSec, sceneDurationSec, 3, 15),
    prompt: String(s.prompt || '').trim(),
  }));

  return plan;
}

async function uploadImageToFilesApi(filePath, apiKey) {
  const bytes = fs.readFileSync(filePath);
  const mimeType = filePath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';

  const startRes = await fetch(`${API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: path.basename(filePath) } }),
  });

  if (!startRes.ok) {
    throw new Error(`Files API start failed (${startRes.status}): ${sanitizeError(await startRes.text())}`);
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API did not return upload URL');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });

  if (!uploadRes.ok) {
    throw new Error(`Files API upload failed (${uploadRes.status}): ${sanitizeError(await uploadRes.text())}`);
  }

  const meta = await uploadRes.json();
  const fileObj = meta.file || meta;
  return { uri: fileObj.uri, mimeType: fileObj.mimeType || mimeType };
}

function extractVideoUri(interaction) {
  if (interaction?.output_video?.uri) return interaction.output_video.uri;
  const outputs = interaction?.outputs || [];
  for (const out of outputs) {
    if (out?.type === 'video' && out?.uri) return out.uri;
    if (out?.video?.uri) return out.video.uri;
  }
  return null;
}

export async function generateSceneClip(prompt, options = {}) {
  const apiKey = requireApiKey();
  const durationSec = clampInt(options.durationSec, 15, 3, 15);
  const resolution = validateResolution(options.resolution || '720p');
  const aspectRatio = options.aspectRatio || '9:16';
  const outputPath = options.outputPath;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;

  const inputParts = [];
  let promptText = prompt.trim();

  if (options.firstFramePath && fs.existsSync(options.firstFramePath)) {
    const uploaded = await uploadImageToFilesApi(options.firstFramePath, apiKey);
    inputParts.push({
      type: 'image',
      uri: uploaded.uri,
      mime_type: uploaded.mimeType,
    });
    if (!promptText.toLowerCase().includes('starting frame')) {
      promptText = `${promptText} Use this image as the starting frame for seamless visual continuity.`;
    }
  }

  inputParts.push({ type: 'text', text: promptText });

  const body = {
    model: VIDEO_MODEL,
    input: inputParts,
    response_format: {
      type: 'video',
      delivery: 'uri',
      aspect_ratio: aspectRatio,
      duration: `${durationSec}s`,
      resolution,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let interaction;
  try {
    const res = await fetch(`${API_BASE}/v1beta/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Omni 1.2 Flash API error (${res.status}): ${sanitizeError(await res.text())}`);
    }
    interaction = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const videoUri = extractVideoUri(interaction);
  if (!videoUri) {
    throw new Error('Omni 1.2 Flash returned no video URI in interaction response');
  }

  const dlUrl = videoUri.includes('alt=media')
    ? videoUri
    : `${videoUri}${videoUri.includes('?') ? '&' : '?'}alt=media`;

  const dlRes = await fetch(dlUrl, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!dlRes.ok) {
    throw new Error(`Video download failed (${dlRes.status}): ${sanitizeError(await dlRes.text())}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const buf = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(outputPath, buf);

  return {
    outputPath,
    interactionId: interaction.id || null,
    bytes: buf.length,
  };
}
