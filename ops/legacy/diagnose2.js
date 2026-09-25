// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  // Check if the file on server has our changes
  conn.exec('grep -n "showExpiredOnly\\|getDaysDiff\\|safeFormatDate\\|notranslate" /root/dar/src/app/renewals/page.tsx | head -20', (err, stream) => {
    let out = '';
    stream.on('close', () => {
      console.log('=== GREP for our changes ===');
      console.log(out || '(NO MATCHES - our changes are NOT on the server!)');
      
      // Also check what the file actually looks like
      conn.exec('head -30 /root/dar/src/app/renewals/page.tsx', (err2, stream2) => {
        let out2 = '';
        stream2.on('close', () => {
          console.log('\n=== FIRST 30 LINES OF SERVER FILE ===');
          console.log(out2);
          
          // Check if the original page even has showExpiredOnly
          conn.exec('grep -c "showExpiredOnly" /root/dar/src/app/renewals/page.tsx', (err3, stream3) => {
            let out3 = '';
            stream3.on('close', () => {
              console.log('\n=== Count of showExpiredOnly occurrences ===');
              console.log(out3);
              
              // Check file size
              conn.exec('wc -l /root/dar/src/app/renewals/page.tsx', (err4, stream4) => {
                let out4 = '';
                stream4.on('close', () => {
                  console.log('\n=== File line count ===');
                  console.log(out4);
                  
                  // Check last build time
                  conn.exec('ls -la /root/dar/.next/BUILD_ID && stat /root/dar/.next/BUILD_ID | grep Modify', (err5, stream5) => {
                    let out5 = '';
                    stream5.on('close', () => {
                      console.log('\n=== Build timestamp ===');
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
