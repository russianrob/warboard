const fs = require('fs');
const wars = JSON.parse(fs.readFileSync('../data/wars.json'));
for (const war of Object.values(wars)) {
    if (war.warEta && war.warEta.hoursRemaining <= 0) {
        console.log("WAR ENDED OR LOST:", war.warId, "target:", war.warEta.currentTarget, "hrs:", war.warEta.hoursRemaining);
    }
}
