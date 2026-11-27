import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RESOLUTION_MAP = {
  '360p': { w: 360, h: 640 },
  '720p': { w: 720, h: 1280 },
  '1080p': { w: 1080, h: 1920 },
  '4k': { w: 2160, h: 3840 },
};

async function runFfmpeg(args) {
  try {
    await execFileAsync('ffmpeg', ['-y', ...args], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr?.slice(-400) || err.message}`);
  }
}

export async function probeVideo(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const vStream = (info.streams || []).find((s) => s.codec_type === 'video');
  const aStream = (info.streams || []).find((s) => s.codec_type === 'audio');
  return {
    durationSec: Number.parseFloat(info.format?.duration || '0'),
    sizeBytes: Number.parseInt(info.format?.size || '0', 10),
    width: vStream?.width || 0,
    height: vStream?.height || 0,
    hasAudio: Boolean(aStream),
  };
}

export async function extractLastFrame(videoPath, outImagePath) {
  fs.mkdirSync(path.dirname(outImagePath), { recursive: true });
  await runFfmpeg([
    '-sseof', '-0.2',
    '-i', videoPath,
    '-update', '1',
    '-frames:v', '1',
    outImagePath,
  ]);
  return outImagePath;
}

export async function generateSyntheticClip(outputPath, { durationSec = 3, resolution = '720p', sceneIndex = 1 }) {
  const { w, h } = RESOLUTION_MAP[resolution] || RESOLUTION_MAP['720p'];
  const colors = ['#1e1b4b', '#312e81', '#0f766e', '#7c2d12', '#581c87', '#14532d'];
  const color = colors[(sceneIndex - 1) % colors.length];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:r=30:d=${durationSec}`,
    '-f', 'lavfi', '-i', `sine=frequency=${280 + sceneIndex * 40}:sample_rate=44100:duration=${durationSec}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    outputPath,
  ]);
  return outputPath;
}

export async function stitchClips(clipPaths, outputPath, resolution = '720p') {
  if (!clipPaths.length) throw new Error('No clips provided to stitch');
  const { w, h } = RESOLUTION_MAP[resolution] || RESOLUTION_MAP['720p'];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Normalize every clip to matching 9:16 H.264/AAC 30fps before concat to avoid timestamp/codec glitches
  const normPaths = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const normPath = `${clipPaths[i]}.norm.mp4`;
    const meta = await probeVideo(clipPaths[i]);
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30,format=yuv420p`;

    if (meta.hasAudio) {
      await runFfmpeg([
        '-i', clipPaths[i],
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
        normPath,
      ]);
    } else {
      await runFfmpeg([
        '-i', clipPaths[i],
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        normPath,
      ]);
    }
    normPaths.push(normPath);
  }

  const listPath = path.join(path.dirname(outputPath), `concat_${Date.now()}.txt`);
  const listContent = normPaths
    .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent, 'utf8');

  try {
    await runFfmpeg([
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);
  } finally {
    fs.rmSync(listPath, { force: true });
    for (const p of normPaths) fs.rmSync(p, { force: true });
  }

  const stats = await probeVideo(outputPath);
  if (stats.sizeBytes === 0) throw new Error('Stitched MP4 is empty');
  return stats;
}
