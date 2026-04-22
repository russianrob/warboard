import cron from 'node-cron';
import axios from 'axios';
import { startHeatmapScraper } from './heatmap-scraper.js';

// Dummy database service structure
const db = {
    getAllRegisteredFactions: async () => {
        return [
            { id: '42055', apiKey: '63CZ7jTvDghXLKDl' }
        ];
    }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Dedupe war.started webhook emission: WarScanner sweeps every few
// minutes and will keep seeing the same active war — we only want the
// event on first detection. Cleared when the process restarts.
const _lastSeenWars = new Set();

async function scanFactions() {
    console.log('[WarScanner] Starting ranked war scan sweep...');
    // dedupe war.started webhook emission per warId across sweeps
    
    try {
        const factions = await db.getAllRegisteredFactions();

        for (const faction of factions) {
            const factionIdStr = String(faction.id);
            
            try {
                console.log(`[WarScanner] Checking faction ${factionIdStr} for active wars...`);
                
                const url = `https://api.torn.com/faction/${factionIdStr}?selections=rankedwars&key=${faction.apiKey}`;
                const response = await axios.get(url);
                const data = response.data;

                if (data.error) {
                    console.error(`[WarScanner] Torn API Error for faction ${factionIdStr}:`, data.error);
                } else if (data.rankedwars) {
                    for (const [warId, warData] of Object.entries(data.rankedwars)) {
                        // Only process active ranked wars (winner is 0 or undefined)
                        if (warData.war && warData.war.winner && warData.war.winner !== 0) {
                            continue;
                        }

                        const participantIds = Object.keys(warData.factions || {});
                        const enemyId = participantIds.find(id => String(id) !== factionIdStr);

                        if (enemyId) {
                            const enemyName = warData.factions[enemyId]?.name || 'Unknown';
                            console.log(`[WarScanner] Active Ranked War detected! WarID: ${warId}, Enemy: ${enemyName} (${enemyId})`);
                            startHeatmapScraper(warId, enemyId, faction.apiKey, enemyName);
                            // Webhook event — fires once per newly-detected war.
                            // _lastSeenWars dedupes so WarScanner sweep doesn't
                            // emit repeatedly for the same ongoing war.
                            try {
                                if (!_lastSeenWars.has(warId)) {
                                    _lastSeenWars.add(warId);
                                    const { emit } = await import('./webhook-bus.js');
                                    emit(factionIdStr, 'war.started', {
                                        warId, enemyFactionId: enemyId, enemyName,
                                        startsAt: warData.war?.start ?? null,
                                        target: warData.war?.target ?? null,
                                    });
                                }
                            } catch (_) {}
                        }
                    }
                }
            } catch (error) {
                console.error(`[WarScanner] Request failed for faction ${factionIdStr}:`, error.message);
            }

            // CRITICAL: 1500ms delay to respect Torn API rate limits (100 requests / minute)
            await delay(1500);
        }
        
        console.log('[WarScanner] Sweep complete.');
    } catch (error) {
        console.error('[WarScanner] Critical failure during sweep:', error.message);
    }
}

// Every Tuesday at 14:00 UTC (Ranked War Matchmaking Day)
cron.schedule('0 14 * * 2', scanFactions, {
    timezone: 'UTC'
});

// Fallback every 4 hours
cron.schedule('0 */4 * * *', scanFactions, {
    timezone: 'UTC'
});

console.log('[WarScanner] Scheduled cron jobs: Tuesdays 14:00 UTC & Every 4 hours fallback.');
scanFactions();
