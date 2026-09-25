// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  const commands = [
    // Look at the ORIGINAL getDaysDiff in rakan (unmodified version)
    'grep -A8 "getDaysDiff" /root/rakan/radeef/src/app/renewals/page.tsx | head -15',
    // Look at the showExpiredOnly filter block in rakan
    'grep -B2 -A5 "showExpiredOnly" /root/rakan/radeef/src/app/renewals/page.tsx | head -20',
    // Check for the exact expiration date display line in rakan
    'grep "expirationDate.*toISO\\|expirationDate.*split\\|safeFormatDate" /root/rakan/radeef/src/app/renewals/page.tsx',
    // Check if rakan has the same crash - test with real URL
    'curl -s -H "Cookie: next-auth.session-token=test" http://127.0.0.1:3001/api/renewals 2>&1 | python3 -m json.tool 2>/dev/null | head -5 || echo "API call failed or needs auth"',
    // Check the DIFF between our dar version and the rakan version
    'diff /root/dar/src/app/renewals/page.tsx /root/rakan/radeef/src/app/renewals/page.tsx 2>/dev/null | head -60',
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
