import { runDailyPipeline } from './pipeline.js';

const dryRun = process.argv.includes('--dry-run');

runDailyPipeline({ dryRun })
  .then((record) => {
    console.log('\nDone:', JSON.stringify({
      id: record.id,
      videoFile: record.videoFile,
      durationSec: record.durationSec,
      tiktok: record.tiktok,
    }, null, 2));
  })
  .catch((err) => {
    console.error('\nFailed:', err.message);
    process.exit(1);
  });
