// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  // Find the actual radeef app path
  conn.exec('pm2 jlist 2>/dev/null | python3 -c \'import sys,json;d=json.load(sys.stdin);r=[p for p in d if p["name"]=="radeef"][0];print("CWD:",r["pm2_env"].get("pm_cwd","??"));print("Script:",r["pm2_env"].get("pm_exec_path","??"))\'', (err, stream) => {
    let out = '';
    stream.on('close', () => {
      console.log('=== PM2 radeef config ===');
      console.log(out);
      
      // Also check nginx for app.radeef-sa.com
      conn.exec('cat /etc/nginx/sites-available/app.radeef-sa.com 2>/dev/null || grep -r "app.radeef-sa.com" /etc/nginx/ 2>/dev/null | head -5', (err2, stream2) => {
        let out2 = '';
        stream2.on('close', () => {
          console.log('\n=== Nginx config for app.radeef-sa.com ===');
          console.log(out2);
          
          // Find where package.json is for radeef
          conn.exec('find /root -maxdepth 3 -name "package.json" -path "*radeef*" 2>/dev/null', (err3, stream3) => {
            let out3 = '';
            stream3.on('close', () => {
              console.log('\n=== package.json locations with radeef ===');
              console.log(out3);
              conn.end();
            }).on('data', d => out3 += d.toString()).stderr.on('data', d => out3 += d.toString());
          });
        }).on('data', d => out2 += d.toString()).stderr.on('data', d => out2 += d.toString());
      });
    }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
  });
}).connect(sshConfig());
