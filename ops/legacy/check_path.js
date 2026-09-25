// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec('ls -la /root/dar/src/app/renewals/page.tsx', (err, stream) => {
    stream.on('close', () => conn.end()).on('data', data => console.log('FILE:', data.toString())).stderr.on('data', data => console.log('ERR:', data.toString()));
  });
}).connect(sshConfig());
