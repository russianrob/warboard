const tests = [
  "2 days 03:00:00",
  "03:00:00",
  "51:00:00",
  "2d 03h 00m"
];
for (const text of tests) {
  const stripped = text.trim().replace(/[^\d:]/g, '');
  const timeParts = stripped.split(':');
  let timerDays = 0, timerHours = 0, timerMinutes = 0, totalElapsedHours = 0;
  if (timeParts.length >= 4) {
      timerDays = parseInt(timeParts[0]) || 0;
      timerHours = parseInt(timeParts[1]) || 0;
      timerMinutes = parseInt(timeParts[2]) || 0;
  } else {
      const hh = parseInt(timeParts[0]) || 0;
      timerDays = Math.floor(hh / 24);
      timerHours = hh % 24;
      timerMinutes = parseInt(timeParts[1]) || 0;
  }
  totalElapsedHours = (timerDays * 24) + timerHours + (timerMinutes / 60);
  console.log(`"${text}" -> stripped: "${stripped}" -> elapsedHrs: ${totalElapsedHours}`);
}
