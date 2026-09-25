// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  const commands = [
    // Check Next.js version
    'cd /root/dar && node -e "console.log(require(\'next/package.json\').version)"',
    // Check node version
    'node -v',
    // Check if .next/static has any chunks
    'ls /root/dar/.next/static/chunks/ | head -10',
    // Check if client reference manifests exist
    'find /root/dar/.next -name "*client-reference*" | head -10',
    // Check .next/server/app/renewals for client ref manifest
    'ls -la /root/dar/.next/server/app/renewals/',
    // Check the content of the renewals page client reference manifest
    'cat /root/dar/.next/server/app/renewals/page_client-reference-manifest.js | head -20',
    // Check if the problem is about the _not-found route
    'ls -la /root/dar/.next/server/app/_not-found/ 2>/dev/null || echo "_not-found dir NOT FOUND"',
    // Check if pages dir has _not-found
    'find /root/dar/.next -path "*_not-found*" -type f | head -10',
    // Delete .next/cache and try once more
    'cd /root/dar && rm -rf .next/cache',
  ];
  
  let idx = 0;
  function runNext() {
    if (idx >= commands.length) { conn.end(); return; }
    const cmd = commands[idx];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`CMD ${idx + 1}: ${cmd}`);
    console.log('='.repeat(60));
    
    conn.exec(cmd, (err, stream) => {
      if (err) { console.log('ERROR:', err); idx++; runNext(); return; }
      let out = '';
      stream.on('close', () => {
        console.log(out);
        idx++;
        runNext();
      }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
    });
  }
  runNext();
}).connect(sshConfig());
