// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  // Test the renewals page
  conn.exec('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/renewals && echo "" && curl -s http://127.0.0.1:3002/renewals 2>&1 | head -c 500', (err, stream) => {
    let out = '';
    stream.on('close', () => {
      console.log('=== Renewals page response ===');
      console.log(out);
      
      // Check if the built chunks contain showExpiredOnly now
      conn.exec('find /root/dar/.next/static -name "*.js" -exec grep -l "showExpiredOnly" {} \\; 2>/dev/null | head -5', (err2, stream2) => {
        let out2 = '';
        stream2.on('close', () => {
          console.log('\n=== Built JS chunks with showExpiredOnly ===');
          console.log(out2 || '(none found - this would be the problem!)');
          
          // Check error logs after rebuild
          conn.exec('pm2 logs dar --err --nostream --lines 10 2>&1', (err3, stream3) => {
            let out3 = '';
            stream3.on('close', () => {
              console.log('\n=== PM2 error logs after rebuild ===');
              console.log(out3);
              conn.end();
            }).on('data', d => out3 += d.toString()).stderr.on('data', d => out3 += d.toString());
          });
        }).on('data', d => out2 += d.toString()).stderr.on('data', d => out2 += d.toString());
      });
    }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
  });
}).connect(sshConfig());
