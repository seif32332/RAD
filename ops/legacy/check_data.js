// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Do not use for deployments.
const { sshConfig } = require('./ssh-config');
const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();
conn.on('ready', () => {
  // First check how many items are expired
  conn.exec("curl -s http://127.0.0.1:3002/api/renewals | python3 -c 'import sys,json; data=json.load(sys.stdin); exp=[d for d in data if d.get(\"expirationDate\",\"\") < \"2026-05-20\"]; print(f\"Total: {len(data)}, Expired: {len(exp)}\")'", (err, stream) => {
    let out = '';
    stream.on('close', () => {
      console.log('=== Data analysis ===');
      console.log(out);
      
      // Check if any items have null/undefined expirationDate
      conn.exec("curl -s http://127.0.0.1:3002/api/renewals | python3 -c 'import sys,json; data=json.load(sys.stdin); bad=[d for d in data if not d.get(\"expirationDate\")]; print(f\"Items with no expirationDate: {len(bad)}\"); [print(d.get(\"entityName\",\"?\"),d.get(\"documentType\",\"?\"),d.get(\"expirationDate\")) for d in bad]'", (err2, stream2) => {
        let out2 = '';
        stream2.on('close', () => {
          console.log('\n=== Items with missing dates ===');
          console.log(out2);
          
          // Check if there's any issue with isEarlyRenewal missing field
          conn.exec("curl -s http://127.0.0.1:3002/api/renewals | python3 -c 'import sys,json; data=json.load(sys.stdin); [print(list(d.keys())) for d in data[:1]]'", (err3, stream3) => {
            let out3 = '';
            stream3.on('close', () => {
              console.log('\n=== First item keys ===');
              console.log(out3);
              conn.end();
            }).on('data', d => out3 += d.toString()).stderr.on('data', d => out3 += d.toString());
          });
        }).on('data', d => out2 += d.toString()).stderr.on('data', d => out2 += d.toString());
      });
    }).on('data', d => out += d.toString()).stderr.on('data', d => out += d.toString());
  });
}).connect(sshConfig());
