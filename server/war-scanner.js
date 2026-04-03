import cron from 'node-cron';
import axios from 'axios';
import { startHeatmapScraper } from './heatmap-scraper.js';

// Dummy database service structure
const db = {
    getAllRegisteredFactions: async () => {
        // In a real application, fetch from MongoDB/Postgres/etc.
        return [
            { id: '123', apiKey: 'dummy_api_key_1' },
            { id: '456', apiKey: 'dummy_api_key_2' }
        ];
    }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scanFactions() {
    console.log('[WarScanner] Starting ranked war scan sweep...');
    
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
                        const participantIds = Object.keys(warData.factions || {});
                        const enemyId = participantIds.find(id => String(id) !== factionIdStr);

                        if (enemyId) {
                            console.log(`[WarScanner] Active Ranked War detected! WarID: ${warId}, EnemyID: ${enemyId}`);
                            startHeatmapScraper(warId, enemyId, faction.apiKey);
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
