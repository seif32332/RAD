// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  const commands = [
    // 1. Check the API route to see what data it returns
    'curl -s http://127.0.0.1:3002/api/renewals | head -c 2000',
    // 2. Check server-side Next.js error logs
    'pm2 logs dar --err --nostream --lines 30 2>&1',
    // 3. Check if there are any build errors in .next
    'cat /root/dar/.next/trace 2>/dev/null | tail -5 || echo "no trace file"',
    // 4. Check the browser-delivered JS for errors - look at the built page
    'ls -la /root/dar/.next/server/app/renewals/ 2>/dev/null',
    // 5. Check if the SearchableSelect component exists and is correct
    'head -20 /root/dar/src/components/SearchableSelect.tsx 2>/dev/null || echo "SearchableSelect NOT FOUND"',
    // 6. Check if DashboardLayout exists
    'head -5 /root/dar/src/components/DashboardLayout.tsx 2>/dev/null || echo "DashboardLayout NOT FOUND"',
    // 7. Check if FileUploadField exists
    'head -5 /root/dar/src/components/FileUploadField.tsx 2>/dev/null || echo "FileUploadField NOT FOUND"',
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
