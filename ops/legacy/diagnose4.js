// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  // Get the API response - need to check with cookie/auth
  conn.exec('curl -s http://127.0.0.1:3002/api/renewals 2>&1 | python3 -m json.tool 2>/dev/null | head -100 || curl -s http://127.0.0.1:3002/api/renewals 2>&1 | head -2000', (err, stream) => {
    let out = '';
    stream.on('close', () => {
      console.log('=== API RESPONSE ===');
      console.log(out);
      
      // Also check the error log more thoroughly
      conn.exec('pm2 logs dar --nostream --lines 5 --err 2>&1', (err2, stream2) => {
        let out2 = '';
        stream2.on('close', () => {
          console.log('\n=== PM2 ERROR LOGS ===');
          console.log(out2);
          
          // Check the actual client-side chunk that was built
          conn.exec('find /root/dar/.next/static -name "*.js" -newer /root/dar/.next/BUILD_ID -exec grep -l "showExpiredOnly" {} \\;', (err3, stream3) => {
            let out3 = '';
            stream3.on('close', () => {
              console.log('\n=== Built JS chunks with showExpiredOnly ===');
              console.log(out3 || '(none found)');
              
              // Let's also check the original page.tsx that was there BEFORE we made changes
              // by looking at git
              conn.exec('cd /root/dar && git log --oneline -5 -- src/app/renewals/page.tsx 2>/dev/null || echo "No git history"', (err4, stream4) => {
                let out4 = '';
                stream4.on('close', () => {
                  console.log('\n=== Git history for page.tsx ===');
                  console.log(out4);
                  
                  // Check if the page was already broken BEFORE our changes
                  // by looking at git status
                  conn.exec('cd /root/dar && git status -- src/app/renewals/page.tsx 2>/dev/null && git diff --stat HEAD -- src/app/renewals/page.tsx 2>/dev/null || echo "No git"', (err5, stream5) => {
                    let out5 = '';
                    stream5.on('close', () => {
                      console.log('\n=== Git status ===');
                      console.log(out5);
                      conn.end();
                    }).on('data', d => out5 += d.toString()).stderr.on('data', d => out5 += d.toString());
                  });
                }).on('data', d => out4 += d.toString()).stderr.on('data', d => out4 += d.toString());
              });
            }).on('data', d => out3 += d.toString()).stderr.on('data', d => out3 += d.toString());
          });
        }).on('data', d => out2 += d.toString()).stderr.on('data', d => out2 += d.toString());
      });
    }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
  });
}).connect(sshConfig());
