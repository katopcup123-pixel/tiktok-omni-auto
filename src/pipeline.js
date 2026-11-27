import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR, readState, sanitizeError, writeState } from './config.js';
import { computeScenePlanCount, generateSceneClip, planEpisode } from './gemini.js';
import { extractLastFrame, generateSyntheticClip, stitchClips } from './assembler.js';
import { publishVideoToTikTok } from './tiktok.js';

let activeRun = null;

export function getActiveRun() {
  return activeRun;
}

export async function runDailyPipeline(overrides = {}) {
  if (activeRun) {
    throw new Error('A generation run is already in progress');
  }

  const state = readState();
  const settings = { ...state.settings, ...overrides };
  const runId = `run_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(OUTPUT_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const logs = [];
  const log = (msg) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.push(line);
    console.log(line);
  };

  activeRun = {
    id: runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    dryRun: Boolean(settings.dryRun),
    logs,
  };

  try {
    const recentTitles = state.runs.map((r) => r.title).filter(Boolean);
    let plan;

    if (settings.dryRun) {
      const { count } = computeScenePlanCount(settings.targetDurationSec, settings.sceneDurationSec);
      const dryScenes = Math.min(count, 3);
      log(`DRY RUN: Building ${dryScenes} synthetic vertical test clips (no API credits spent)...`);
      plan = {
        title: `[DRY RUN] ${settings.contentNiche}`,
        caption: `Test video for ${settings.contentNiche}`,
        hashtags: ['#tiktok', '#ai', '#omni'],
        scenes: Array.from({ length: dryScenes }, (_, i) => ({
          index: i + 1,
          durationSec: 3,
          prompt: `Synthetic test scene ${i + 1}`,
        })),
      };
    } else {
      log(`Planning episode for niche: "${settings.contentNiche}" (${settings.targetDurationSec}s)...`);
      plan = await planEpisode(settings, recentTitles);
      log(`Planned "${plan.title}" with ${plan.scenes.length} scenes.`);
    }

    fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

    const clipPaths = [];
    let prevLastFrame = null;

    for (const scene of plan.scenes) {
      const clipPath = path.join(runDir, `scene_${String(scene.index).padStart(2, '0')}.mp4`);
      if (settings.dryRun) {
        log(`Generating synthetic clip ${scene.index}/${plan.scenes.length}...`);
        await generateSyntheticClip(clipPath, {
          durationSec: scene.durationSec,
          resolution: settings.resolution,
          sceneIndex: scene.index,
        });
      } else {
        log(`Calling Gemini Omni 1.2 Flash for scene ${scene.index}/${plan.scenes.length} (${scene.durationSec}s, ${settings.resolution})...`);
        await generateSceneClip(scene.prompt, {
          durationSec: scene.durationSec,
          resolution: settings.resolution,
          aspectRatio: '9:16',
          firstFramePath: settings.chainFrames ? prevLastFrame : null,
          outputPath: clipPath,
        });
      }

      clipPaths.push(clipPath);

      if (settings.chainFrames && scene.index < plan.scenes.length) {
        const framePath = path.join(runDir, `frame_${String(scene.index).padStart(2, '0')}.png`);
        await extractLastFrame(clipPath, framePath);
        prevLastFrame = framePath;
      }
    }

    const finalFilename = `${runId}_final.mp4`;
    const finalPath = path.join(OUTPUT_DIR, finalFilename);
    log(`Stitching ${clipPaths.length} clips into ${finalFilename}...`);
    const videoMeta = await stitchClips(clipPaths, finalPath, settings.resolution);
    log(`Final video ready: ${videoMeta.durationSec.toFixed(1)}s, ${videoMeta.width}x${videoMeta.height}, ${(videoMeta.sizeBytes / 1024 / 1024).toFixed(2)} MB.`);

    const fullCaption = [
      plan.caption || plan.title,
      ...(Array.isArray(plan.hashtags) ? plan.hashtags : []),
    ].join(' ').trim();

    let tiktokResult = { status: 'SKIPPED' };
    const latestState = readState();

    if (settings.dryRun) {
      log('DRY RUN: Skipping TikTok upload.');
    } else if (!latestState.tiktok?.refreshToken) {
      log('TikTok account not connected — video saved locally only.');
    } else {
      tiktokResult = await publishVideoToTikTok(finalPath, {
        caption: fullCaption,
        privacyLevel: settings.privacyLevel,
        onLog: log,
      });
    }

    const record = {
      id: runId,
      startedAt: activeRun.startedAt,
      finishedAt: new Date().toISOString(),
      status: 'success',
      dryRun: Boolean(settings.dryRun),
      title: plan.title,
      caption: fullCaption,
      videoFile: finalFilename,
      durationSec: Number(videoMeta.durationSec.toFixed(1)),
      tiktok: tiktokResult,
      logs,
    };

    latestState.runs = [record, ...latestState.runs].slice(0, 30);
    writeState(latestState);
    return record;
  } catch (err) {
    const cleanErr = sanitizeError(err);
    log(`ERROR: ${cleanErr}`);
    const latestState = readState();
    const record = {
      id: runId,
      startedAt: activeRun.startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      dryRun: Boolean(settings.dryRun),
      error: cleanErr,
      logs,
    };
    latestState.runs = [record, ...latestState.runs].slice(0, 30);
    writeState(latestState);
    throw err;
  } finally {
    activeRun = null;
  }
}
