// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const path = require('path');
const { sshConfig, localRepoDir } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Connected. Deploying to rakan and radeef...\n');
  
  conn.sftp((err, sftp) => {
    if (err) { console.log('SFTP error:', err); conn.end(); return; }
    
    const localPage = path.join(localRepoDir(), 'src', 'app', 'renewals', 'page.tsx');
    const localError = path.join(localRepoDir(), 'src', 'app', 'renewals', 'error.tsx');
    
    const targets = [
      { name: 'rakan', path: '/root/rakan/radeef' },
      { name: 'radeef', path: '/var/www/radeef' },
    ];
    
    let idx = 0;
    
    function deployNext() {
      if (idx >= targets.length) {
        console.log('\n✅ All deployments complete!');
        conn.end();
        return;
      }
      
      const target = targets[idx];
      console.log(`\n${'='.repeat(50)}`);
      console.log(`Deploying to ${target.name} (${target.path})...`);
      console.log('='.repeat(50));
      
      // Upload page.tsx
      sftp.fastPut(localPage, `${target.path}/src/app/renewals/page.tsx`, (err1) => {
        if (err1) { console.log(`❌ Upload page.tsx failed for ${target.name}:`, err1.message); idx++; deployNext(); return; }
        console.log(`✅ page.tsx uploaded to ${target.name}`);
        
        // Upload error.tsx
        sftp.fastPut(localError, `${target.path}/src/app/renewals/error.tsx`, (err2) => {
          if (err2) { console.log(`⚠️ error.tsx upload failed (non-critical):`, err2.message); }
          else { console.log(`✅ error.tsx uploaded to ${target.name}`); }
          
          // Build
          console.log(`🔨 Building ${target.name}...`);
          conn.exec(`cd ${target.path} && npm run build 2>&1 | tail -5`, (err3, stream3) => {
            let buildOut = '';
            stream3.on('close', (code) => {
              console.log(`Build exit code: ${code}`);
              console.log(buildOut);
              
              if (code === 0) {
                conn.exec(`pm2 restart ${target.name} 2>&1`, (err4, stream4) => {
                  let restartOut = '';
                  stream4.on('close', () => {
                    console.log(`🚀 ${target.name} restarted!`);
                    idx++;
                    deployNext();
                  }).on('data', d => restartOut += d.toString()).stderr.on('data', d => restartOut += d.toString());
                });
              } else {
                console.log(`❌ Build failed for ${target.name}`);
                idx++;
                deployNext();
              }
            }).on('data', d => buildOut += d.toString()).stderr.on('data', d => buildOut += d.toString());
          });
        });
      });
    }
    
    deployNext();
  });
}).connect(sshConfig());
