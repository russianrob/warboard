const tests = [
  "2 days, 03:00:00",
  "03:00:00",
  "51:00:00",
  "Time left: 02:03:00:00",
  "Starts in 1 day 02:00:00"
];
for (const text of tests) {
  const parts = text.match(/\d+/g);
  let timerDays = 0, timerHours = 0, timerMinutes = 0, totalElapsedHours = 0;
  if (parts) {
      if (parts.length >= 4) {
          timerDays = parseInt(parts[0]) || 0;
          timerHours = parseInt(parts[1]) || 0;
          timerMinutes = parseInt(parts[2]) || 0;
      } else if (parts.length === 3) {
          const hh = parseInt(parts[0]) || 0;
          timerDays = Math.floor(hh / 24);
          timerHours = hh % 24;
          timerMinutes = parseInt(parts[1]) || 0;
      } else if (parts.length === 2) {
          timerHours = 0;
          timerMinutes = parseInt(parts[0]) || 0;
      }
      totalElapsedHours = (timerDays * 24) + timerHours + (timerMinutes / 60);
  }
  console.log(`"${text}" -> parsed: ${totalElapsedHours} hours`);
}
