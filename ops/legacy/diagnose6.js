// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  const commands = [
    // Check the DashboardLayout for any issues
    'wc -l /root/dar/src/components/DashboardLayout.tsx',
    // Check if there's an error boundary
    'grep -r "ErrorBoundary\\|error.tsx\\|error.js" /root/dar/src/app/ 2>/dev/null | head -10',
    // Check the global error handler
    'cat /root/dar/src/app/error.tsx 2>/dev/null || cat /root/dar/src/app/error.js 2>/dev/null || echo "No global error handler!"',
    // Check if there's a global layout issue
    'cat /root/dar/src/app/layout.tsx 2>/dev/null | head -40',
    // Most importantly - let's check the BROWSER console error by looking at the _error page 
    // Check the Next.js config
    'cat /root/dar/next.config.js 2>/dev/null || cat /root/dar/next.config.mjs 2>/dev/null || cat /root/dar/next.config.ts 2>/dev/null || echo "No next config found"',
    // Check if maybe the issue is that ALL expired items have been processed and the filtering creates an empty list which crashes
    'curl -s http://127.0.0.1:3002/api/renewals | python3 -c "import sys,json; data=json.load(sys.stdin); exp=[d for d in data if d.get(\"expirationDate\",\"\") < \"2026-05-20\"]; print(f\"Total: {len(data)}, Expired: {len(exp)}\")" 2>/dev/null || echo "Could not check"',
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
