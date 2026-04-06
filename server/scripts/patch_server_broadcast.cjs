const fs = require('fs');
const path = '../server.js';
let code = fs.readFileSync(path, 'utf8');

const oldCode = `io.on("connection", (socket) => {
  console.log(\`[ws] Socket connected: \${socket.id} (player: \${socket.user.playerName})\`);
  registerSocketHandlers(io, socket);`;

const newCode = `io.on("connection", (socket) => {
  console.log(\`[ws] Socket connected: \${socket.id} (player: \${socket.user.playerName})\`);
  
  // Admin Broadcast Listener
  socket.on('admin_broadcast', (data) => {
      // Security Check: Lock this down to player ID 137558
      const myPlayerId = '137558'; 
      
      if (socket.user && String(socket.user.playerId) === myPlayerId) {
          io.emit('global_toast', { 
              message: data.message, 
              type: data.type || 'info' 
          });
          console.log(\`[📣] Admin Broadcast sent: \${data.message}\`);
      } else {
          console.log(\`[⚠️] Blocked unauthorized broadcast attempt.\`);
      }
  });

  registerSocketHandlers(io, socket);`;

if (code.includes(oldCode)) {
    fs.writeFileSync(path, code.replace(oldCode, newCode));
    console.log('Successfully patched server.js with Admin Broadcast Listener');
} else {
    console.log('Failed to find old code in server.js');
}
