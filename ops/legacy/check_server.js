// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('grep -ri "dar.radeef-sa.com" /etc/nginx/sites-available /etc/nginx/conf.d', (err, stream) => {
    if (err) throw err;
    let output = '';
    stream.on('close', (code, signal) => {
      console.log('NGINX CONFIG:');
      console.log(output);
      
      // Now get PM2 config
      conn.exec('pm2 jlist', (err2, stream2) => {
         let pm2Out = '';
         stream2.on('close', () => {
             try {
               const list = JSON.parse(pm2Out);
               const darProc = list.find(p => p.name === 'dar');
               if (darProc) {
                   console.log('PM2 DAR CWD:', darProc.pm2_env.pm_cwd);
               } else {
                   console.log('PM2 list:', list.map(p => ({name: p.name, cwd: p.pm2_env.pm_cwd})));
               }
             } catch(e) {
               console.log('PM2 output parse error', e);
             }
             conn.end();
         }).on('data', data => { pm2Out += data; });
      });

    }).on('data', (data) => {
      output += data;
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect(sshConfig());
