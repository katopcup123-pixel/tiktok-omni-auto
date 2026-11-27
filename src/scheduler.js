import { readState, writeState } from './config.js';
import { getActiveRun, runDailyPipeline } from './pipeline.js';

let timer = null;

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function currentHHMM(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    const state = readState();
    if (!state.settings.schedulerEnabled) return;
    if (getActiveRun()) return;

    const now = new Date();
    const today = todayKey(now);
    if (state.lastScheduledDate === today) return;
    if (currentHHMM(now) < state.settings.dailyPostTime) return;

    state.lastScheduledDate = today;
    writeState(state);

    console.log(`[Scheduler] Triggering daily TikTok run for ${today} at ${state.settings.dailyPostTime}`);
    try {
      await runDailyPipeline({ dryRun: state.settings.dryRun });
    } catch (err) {
      console.error('[Scheduler] Daily run failed:', err.message);
    }
  }, 30_000);
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
