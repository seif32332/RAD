'use strict';
/**
 * SSH helpers. Secrets are NEVER placed in a command string: they are delivered on stdin and
 * read into exported variables by the remote shell (`IFS= read -r NAME`), so they do not appear
 * in `ps`, shell history, or our own logs.
 */
const { Client } = require('ssh2');
const { validateEnvName, assertSingleLineSecret, shq } = require('./validate');

const MAX_CAPTURE = 256 * 1024;

class RemoteCommandError extends Error {
  constructor(label, code, stderr) {
    super(`${label} failed (exit ${code})`);
    this.name = 'RemoteCommandError';
    this.code = code;
    this.stderrTail = String(stderr || '').slice(-800);
  }
}

function connect(sshOptions) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(err))
      .connect(sshOptions);
  });
}

async function withConnection(sshOptions, fn) {
  const conn = await connect(sshOptions);
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

function appendCapped(buf, chunk) {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
}

/**
 * Run a command. Options:
 *   secrets   {NAME: value}  exported to the command through stdin (never in argv)
 *   stdin     string         extra data written after the secrets (e.g. SQL for psql -f -)
 *   allowFail boolean        resolve instead of throwing on a non-zero exit code
 *   label     string         short description used in errors
 *   onData    (text) => void streaming callback (stdout + stderr)
 *   timeoutMs number         kill the channel after this long (default 30 min)
 */
function exec(conn, cmd, options = {}) {
  const { secrets = {}, stdin = '', allowFail = false, label = 'remote command', onData, timeoutMs = 30 * 60 * 1000 } = options;
  const names = Object.keys(secrets).filter((n) => secrets[n] !== undefined && secrets[n] !== null && secrets[n] !== '');
  let full = cmd;
  let input = '';
  if (names.length > 0) {
    for (const n of names) {
      validateEnvName(n);
      assertSingleLineSecret(secrets[n], n);
    }
    full = `${names.map((n) => `IFS= read -r ${n} && export ${n}`).join(' && ')} && ( ${cmd} )`;
    input = names.map((n) => `${secrets[n]}\n`).join('');
  }
  input += stdin;

  return new Promise((resolve, reject) => {
    conn.exec(full, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          stream.close();
        } catch {
          /* ignore */
        }
        reject(new RemoteCommandError(`${label} (timeout)`, -1, stderr));
      }, timeoutMs);

      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          const result = { code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() };
          if (result.code !== 0 && !allowFail) reject(new RemoteCommandError(label, result.code, stderr));
          else resolve(result);
        })
        .on('data', (data) => {
          const text = data.toString();
          stdout = appendCapped(stdout, text);
          if (onData) onData(text);
        });
      stream.stderr.on('data', (data) => {
        const text = data.toString();
        stderr = appendCapped(stderr, text);
        if (onData) onData(text);
      });
      stream.end(input);
    });
  });
}

function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

/**
 * Write a remote file atomically: SFTP to a temp file next to it, chmod, then `mv -f`.
 * No file content ever passes through a shell command line.
 */
async function writeRemoteFile(conn, remotePath, content, mode = 0o644) {
  const sftp = await getSftp(conn);
  const tmp = `${remotePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await new Promise((resolve, reject) => {
      sftp.writeFile(tmp, content, { mode }, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      sftp.chmod(tmp, mode, (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    sftp.end();
  }
  await exec(conn, `mv -f -- ${shq(tmp)} ${shq(remotePath)}`, { label: `install ${remotePath}` });
}

async function remoteTest(conn, testExpr) {
  const { code } = await exec(conn, `test ${testExpr}`, { allowFail: true, label: 'test' });
  return code === 0;
}

module.exports = { RemoteCommandError, connect, withConnection, exec, writeRemoteFile, remoteTest };
