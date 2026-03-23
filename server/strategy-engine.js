/**
 * Push/Turtle strategy recommendation engine.
 *
 * Evaluates live war state and returns a tactical recommendation:
 * PUSH (attack aggressively), HOLD (maintain position), or TURTLE (defend/conserve).
 *
 * @author RussianRob
 */

/**
 * Determine the current war phase based on elapsed time and scores.
 * @param {object} war
 * @returns {"pre"|"opening"|"mid"|"late"}
 */
function getWarPhase(war) {
  const scores = war.warScores;
  if (!scores || (scores.myScore === 0 && scores.enemyScore === 0)) return "pre";
  const total = (scores.myScore || 0) + (scores.enemyScore || 0);
  if (total < 200) return "opening";
  const target = war.warTarget?.value || 0;
  if (target > 0 && (scores.myScore || 0) >= target * 0.7) return "late";
  if (total > 1000) return "late";
  return "mid";
}

/**
 * Get enemy peak and dead hour from activity-by-hour data.
 * @param {object} activityByHour — { 0: avgOnline, 1: avgOnline, ... 23: avgOnline }
 * @returns {{ peak: { hour: number, avgOnline: number }, dead: { hour: number, avgOnline: number }, peakHours: number[], deadHours: number[] }}
 */
function getEnemyPeakDead(activityByHour) {
  if (!activityByHour || Object.keys(activityByHour).length === 0) {
    return {
      peak: { hour: 20, avgOnline: 0 },
      dead: { hour: 4, avgOnline: 0 },
      peakHours: [],
      deadHours: [],
    };
  }

  const entries = Object.entries(activityByHour)
    .map(([h, avg]) => ({ hour: Number(h), avgOnline: avg }))
    .sort((a, b) => b.avgOnline - a.avgOnline);

  const count = entries.length;
  const top25 = Math.max(1, Math.ceil(count * 0.25));
  const bottom25 = Math.max(1, Math.ceil(count * 0.25));

  return {
    peak: entries[0],
    dead: entries[entries.length - 1],
    peakHours: entries.slice(0, top25).map((e) => e.hour),
    deadHours: entries.slice(-bottom25).map((e) => e.hour),
  };
}

/**
 * Evaluate the current war situation and return a strategy recommendation.
 *
 * @param {object} war — full war object from store
 * @param {number} ourOnline — our faction online count
 * @param {number} enemyOnline — enemy online count
 * @param {object} enemyActivityByHour — { 0: avgOnline, 1: avgOnline, ... }
 * @returns {object} strategy recommendation
 */
export function evaluateStrategy(war, ourOnline, enemyOnline, enemyActivityByHour) {
  let score = 0; // positive = PUSH, negative = TURTLE
  const reasons = [];

  const scores = war.warScores || { myScore: 0, enemyScore: 0 };
  const myScore = scores.myScore || 0;
  const enemyScore = scores.enemyScore || 0;
  const totalScore = myScore + enemyScore;
  const chain = war.chainData || { current: 0, timeout: 0 };
  const phase = getWarPhase(war);
  const { peak, dead, peakHours, deadHours } = getEnemyPeakDead(enemyActivityByHour);
  const currentHour = new Date().getUTCHours();

  // ── Score difference analysis ──
  if (totalScore > 0) {
    const scoreDiff = myScore - enemyScore;
    const pctDiff = scoreDiff / Math.max(totalScore, 1);

    if (pctDiff < -0.1) {
      // We're behind
      score += 20;
      reasons.push("Behind on score — need to catch up");
    } else if (pctDiff > 0.2) {
      // We're significantly ahead
      score -= 20;
      reasons.push("Significant score lead — protect advantage");
    }
  }

  // ── Roster advantage ──
  if (enemyOnline > 0 && ourOnline > 0) {
    if (ourOnline > enemyOnline) {
      score += 15;
      reasons.push(`Roster advantage: ${ourOnline} vs ${enemyOnline} enemy`);
    }
    if (ourOnline > enemyOnline * 1.5) {
      score += 15;
      reasons.push("Significant numbers advantage (>1.5x)");
    }
    if (enemyOnline > ourOnline && peakHours.includes(currentHour)) {
      score -= 15;
      reasons.push("Enemy in peak hours with more fighters online");
    }
  }

  // ── Thin roster ──
  if (ourOnline < 5 && ourOnline > 0) {
    score -= 10;
    reasons.push(`Thin roster (${ourOnline} online) — conserve energy`);
  }

  // ── Timing: enemy dead/peak zone ──
  if (deadHours.includes(currentHour)) {
    score += 20;
    reasons.push("Enemy dead zone hour — strike now");
  } else if (peakHours.includes(currentHour)) {
    score -= 10;
    reasons.push("Enemy peak activity hour — expect resistance");
  }

  // ── Chain advantage ──
  if (chain.timeout > 0) {
    // We have an active chain
    score += 10;
    reasons.push("Our chain is active — keep momentum");
  }

  // ── Late-phase adjustments ──
  if (phase === "late") {
    if (myScore > enemyScore) {
      score -= 15;
      reasons.push("Late war with lead — run the clock");
    } else if (myScore < enemyScore) {
      score += 10;
      reasons.push("Late war and behind — push hard now");
    }
  }

  // ── Determine recommendation ──
  let recommendation;
  if (score > 20) {
    recommendation = "PUSH";
  } else if (score < -20) {
    recommendation = "TURTLE";
  } else {
    recommendation = "HOLD";
  }

  const confidence = Math.min(100, Math.abs(score));

  // ── Timing assessment ──
  let timing;
  if (deadHours.includes(currentHour) && ourOnline > enemyOnline) {
    timing = "good";
  } else if (peakHours.includes(currentHour) && enemyOnline >= ourOnline) {
    timing = "bad";
  } else {
    timing = "neutral";
  }

  // Trim reasons to top 5 most relevant
  const topReasons = reasons.slice(0, 5);

  return {
    recommendation,
    confidence,
    reasons: topReasons,
    timing,
    enemyPeak: peak,
    enemyDead: dead,
    currentPhase: phase,
    currentHour,
    score,
  };
}

/**
 * Bucket enemy activity log entries by hour-of-day (0-23 UTC).
 * @param {Array<{timestamp: number, online: number, idle: number, total: number}>} log
 * @returns {object} — { 0: avgOnline, 1: avgOnline, ..., 23: avgOnline }
 */
export function getEnemyActivityByHour(log) {
  if (!log || log.length === 0) return {};

  const buckets = {}; // hour → { sum, count }
  for (const entry of log) {
    const hour = new Date(entry.timestamp).getUTCHours();
    if (!buckets[hour]) buckets[hour] = { sum: 0, count: 0 };
    buckets[hour].sum += entry.online;
    buckets[hour].count += 1;
  }

  const result = {};
  for (const [hour, { sum, count }] of Object.entries(buckets)) {
    result[Number(hour)] = Math.round((sum / count) * 10) / 10;
  }
  return result;
}
