// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const path = require('path');
const { sshConfig, localRepoDir } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected. Uploading fixed page.tsx...');
  
  conn.sftp((err, sftp) => {
    if (err) { console.log('SFTP error:', err); conn.end(); return; }
    
    sftp.fastPut(
      path.join(localRepoDir(), 'src', 'app', 'renewals', 'page.tsx'),
      '/root/dar/src/app/renewals/page.tsx',
      (err) => {
        if (err) { console.log('Upload error:', err); conn.end(); return; }
        console.log('page.tsx uploaded!');
        
        console.log('Building...');
        conn.exec('cd /root/dar && npm run build 2>&1 | tail -10', (err2, stream2) => {
          let out = '';
          stream2.on('close', (code) => {
            console.log('BUILD (exit code: ' + code + '):');
            console.log(out);
            
            if (code === 0) {
              conn.exec('pm2 restart dar 2>&1', (err3, stream3) => {
                let out3 = '';
                stream3.on('close', () => {
                  console.log('PM2 RESTART:', out3);
                  console.log('\nDONE! Test the page now.');
                  conn.end();
                }).on('data', d => out3 += d.toString()).stderr.on('data', d => out3 += d.toString());
              });
            } else {
              console.log('BUILD FAILED!');
              conn.end();
            }
          }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
        });
      }
    );
  });
}).connect(sshConfig());
