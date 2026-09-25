// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected to server');
  
  const commands = [
    // 1. Check if our file was actually uploaded
    'head -5 /root/dar/src/app/renewals/page.tsx',
    // 2. Check the file modification time
    'stat /root/dar/src/app/renewals/page.tsx | grep Modify',
    // 3. Check PM2 logs for dar - last 50 lines
    'pm2 logs dar --nostream --lines 50 2>&1',
    // 4. Check if there's a build error log
    'cat /root/dar/.next/BUILD_ID 2>/dev/null || echo "No BUILD_ID"',
    // 5. Check the nginx config for dar to see what port it proxies to
    'cat /etc/nginx/sites-available/dar.radeef-sa.com',
    // 6. Check the original renewals page on server for comparison
    'grep -n "showExpiredOnly\|getDaysDiff\|safeFormatDate\|notranslate" /root/dar/src/app/renewals/page.tsx | head -20',
  ];
  
  let idx = 0;
  function runNext() {
    if (idx >= commands.length) {
      conn.end();
      return;
    }
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
