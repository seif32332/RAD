// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const path = require('path');
const { sshConfig, localRepoDir } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected. Deploying to radeef (/root)...');
  
  conn.sftp((err, sftp) => {
    if (err) { console.log('SFTP error:', err); conn.end(); return; }
    
    const localPage = path.join(localRepoDir(), 'src', 'app', 'renewals', 'page.tsx');
    const localError = path.join(localRepoDir(), 'src', 'app', 'renewals', 'error.tsx');
    
    sftp.fastPut(localPage, '/root/src/app/renewals/page.tsx', (err1) => {
      if (err1) { console.log('❌ Upload page.tsx failed:', err1.message); conn.end(); return; }
      console.log('✅ page.tsx uploaded');
      
      sftp.fastPut(localError, '/root/src/app/renewals/error.tsx', (err2) => {
        if (err2) console.log('⚠️ error.tsx failed:', err2.message);
        else console.log('✅ error.tsx uploaded');
        
        console.log('🔨 Building...');
        conn.exec('cd /root && npm run build 2>&1 | tail -10', (err3, stream) => {
          let out = '';
          stream.on('close', (code) => {
            console.log('Build exit code:', code);
            console.log(out);
            
            if (code === 0) {
              conn.exec('pm2 restart radeef 2>&1', (err4, stream4) => {
                let out4 = '';
                stream4.on('close', () => {
                  console.log('🚀 radeef restarted!');
                  console.log(out4);
                  conn.end();
                }).on('data', d => out4 += d.toString()).stderr.on('data', d => out4 += d.toString());
              });
            } else {
              console.log('❌ Build failed');
              conn.end();
            }
          }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
        });
      });
    });
  });
}).connect(sshConfig());
