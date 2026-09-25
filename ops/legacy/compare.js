// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  const commands = [
    // Check if the problem is already in the ORIGINAL code before our changes
    // Look at the other servers (rakan/radeef) to see if they also have this button
    'grep -c "showExpiredOnly" /root/rakan/radeef/src/app/renewals/page.tsx 2>/dev/null || echo "Not found in rakan"',
    'grep -c "showExpiredOnly" /var/www/radeef/src/app/renewals/page.tsx 2>/dev/null || echo "Not found in radeef"',
    // Check if the other servers ALSO have this problem
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/renewals 2>/dev/null',
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/renewals 2>/dev/null',
    // Let's look at what port each app uses
    'pm2 jlist 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);[print(p[\'name\'],p[\'pm2_env\'].get(\'PORT\',\'??\'),p[\'pm2_env\'].get(\'pm_cwd\',\'\')) for p in d]"',
    // Check the ORIGINAL renewals page in rakan (unchanged version)
    'grep "showExpiredOnly" /root/rakan/radeef/src/app/renewals/page.tsx | head -5 2>/dev/null || echo "showExpiredOnly not in rakan"',
    // Let's look at the original page to see if showExpiredOnly existed before
    'head -30 /root/rakan/radeef/src/app/renewals/page.tsx 2>/dev/null || echo "File not found"',
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
