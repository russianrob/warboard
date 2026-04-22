import axios from 'axios';
import { recordSample } from './activity-heatmap.js';

// Track active scrapers to prevent duplicate intervals for the same enemy faction
const activeScrapers = new Set();

// Dedicated key for heatmap scraping — keeps OWNER_API_KEY free from
// this poller's load. Set via HEATMAP_API_KEY env var. Falls back to
// whatever key the caller passes in, which ultimately falls back to
// OWNER_API_KEY (legacy behaviour) if neither is configured.
const HEATMAP_API_KEY = process.env.HEATMAP_API_KEY || '';

/**
 * Starts an hourly scraper to monitor enemy faction activity.
 * @param {string|number} warId - The ID of the ranked war.
 * @param {string|number} enemyId - The Torn faction ID of the enemy.
 * @param {string} apiKeyFallback - Key to use if HEATMAP_API_KEY env is not set.
 * @param {string} [enemyName] - Optional faction name for better logging.
 * @returns {NodeJS.Timeout|null} The interval ID, or null if already running.
 */
export function startHeatmapScraper(warId, enemyId, apiKeyFallback, enemyName = null) {
    const apiKey = HEATMAP_API_KEY || apiKeyFallback;
    const enemyIdStr = String(enemyId);
    let currentName = enemyName;

    if (activeScrapers.has(enemyIdStr)) {
        console.log(`[HeatmapScraper] Scraper already active for enemy faction ${currentName || enemyIdStr} (War: ${warId})`);
        return null;
    }

    activeScrapers.add(enemyIdStr);
    console.log(`[HeatmapScraper] Starting activity scraper for war ${warId}, enemy ${currentName || enemyIdStr}`);

    const scrape = async () => {
        try {
            const url = `https://api.torn.com/faction/${enemyIdStr}?selections=basic&key=${apiKey}`;
            const response = await axios.get(url);
            const data = response.data;

            if (data.error) {
                console.error(`[HeatmapScraper] Torn API Error for faction ${currentName || enemyIdStr}:`, data.error);
                return;
            }

            // Update name from API response if we didn't have one or if it changed
            if (data.name) {
                currentName = data.name;
            }

            let activeCount = 0;
            const members = data.members || {};
            const totalMembers = Object.keys(members).length;

            for (const member of Object.values(members)) {
                if (member.last_action && member.last_action.status) {
                    const status = (member.last_action.status || "").toLowerCase();
                    if (status === "online" || status === "idle") {
                        activeCount++;
                    }
                }
            }

            recordSample(enemyIdStr, activeCount, totalMembers);
            console.log(`[HeatmapScraper] Recorded ${activeCount} active members for enemy faction ${currentName} (${enemyIdStr}) (Total: ${totalMembers})`);

        } catch (error) {
            console.error(`[HeatmapScraper] Network/Request failed for faction ${currentName || enemyIdStr}:`, error.message);
        }
    };

    scrape();
    const intervalId = setInterval(scrape, 3600000);
    return intervalId;
}
