// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected. Running full rebuild...');
  
  // Delete .next and rebuild completely
  conn.exec('cd /root/dar && rm -rf .next && npm run build 2>&1 | tail -50', (err, stream) => {
    if (err) { console.log('ERROR:', err); conn.end(); return; }
    let out = '';
    stream.on('close', (code) => {
      console.log('=== BUILD OUTPUT (exit code: ' + code + ') ===');
      console.log(out);
      
      if (code === 0) {
        // Restart pm2
        conn.exec('pm2 restart dar 2>&1', (err2, stream2) => {
          let out2 = '';
          stream2.on('close', () => {
            console.log('\n=== PM2 RESTART ===');
            console.log(out2);
            
            // Wait 3 seconds then test
            setTimeout(() => {
              conn.exec('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/renewals', (err3, stream3) => {
                let out3 = '';
                stream3.on('close', () => {
                  console.log('\n=== HTTP STATUS for /renewals ===');
                  console.log(out3);
                  conn.end();
                }).on('data', d => out3 += d.toString()).stderr.on('data', d => out3 += d.toString());
              });
            }, 3000);
          }).on('data', d => out2 += d.toString()).stderr.on('data', d => out2 += d.toString());
        });
      } else {
        console.log('\nBUILD FAILED! Checking for errors...');
        conn.end();
      }
    }).on('data', d => { out += d.toString(); }).stderr.on('data', d => { out += d.toString(); });
  });
}).connect(sshConfig());
