const fs = require('fs');
const path = '../routes.js';
let code = fs.readFileSync(path, 'utf8');

// Fix: Replace ?? with || and object spread with Object.assign
code = code.replace(/req.body \?\? \{\}/g, '(req.body || {})');
code = code.replace(/\{ type: 'global_toast', \.\.\.payload \}/g, 'Object.assign({ type: "global_toast" }, payload)');

fs.writeFileSync(path, code);
console.log('Successfully fixed syntax errors in routes.js');
