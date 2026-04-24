module.exports = {
  apps : [{
    name: "warboard",
    script: "/opt/warboard/server/server.js",
    cwd: "/opt/warboard/server",
    log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",
    // Drop privileges: pm2 God daemon stays as root (so it can read
    // pm2 state + write logs in /root/.pm2/), but the Node worker
    // process runs as the unprivileged `warboard` user. A compromise
    // of the app's code execution is now contained to that user —
    // can't read SSH keys, /etc/shadow, or other users' data.
    uid: "warboard",
    gid: "warboard",
  }]
}
