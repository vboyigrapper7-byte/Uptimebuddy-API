require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { syncMonitors } = require('../src/core/queue/scheduler');
const { monitorQueue } = require('../src/core/queue/setup');

async function verify() {
    console.log('--- Monitor Synchronization Verification ---');
    
    try {
        // 1. Check current queue state
        const initialJobs = await monitorQueue.getRepeatableJobs();
        console.log(`Initial repeatable jobs in queue: ${initialJobs.length}`);

        // 2. Run Sync
        await syncMonitors();

        // 3. Check final queue state
        const finalJobs = await monitorQueue.getRepeatableJobs();
        console.log(`Final repeatable jobs in queue: ${finalJobs.length}`);
        
        finalJobs.forEach(job => {
            console.log(` - Job ID: ${job.id} | Interval: ${job.every / 1000}s | Next Run: ${new Date(job.next).toLocaleString()}`);
        });

        process.exit(0);
    } catch (err) {
        console.error('Verification failed:', err.message);
        process.exit(1);
    }
}

verify();
