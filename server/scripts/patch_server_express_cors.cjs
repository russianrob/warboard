const fs = require('fs');
const path = '../server.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `const app = express();

app.use(
  cors({`;

const newCode = `const app = express();

// Enable CORS for all API routes
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (/\.torn\.com$/.test(origin) || /tornwar\.com/.test(origin) || /^https?:\/\/localhost/.test(origin)) {
        return callback(null, true);
      }
      callback(null, false);
    },
    credentials: true,
  })
);

app.use(
  cors({`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully added global CORS to Express app');
} else {
    console.log('Failed to find old code in server.js');
}
