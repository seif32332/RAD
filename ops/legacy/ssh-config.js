// DEPRECATED legacy diagnostics helper.
// Builds the ssh2 connection config from environment variables. No credential is ever
// stored in this repository: every value MUST come from the environment.
//
//   SSH_HOST       (required) server hostname or IP
//   SSH_PORT       (optional) default 22
//   SSH_USER       (required) a non-root deploy user is strongly recommended
//   SSH_KEY_PATH   (preferred) path to a private key file
//   SSH_PASSWORD   (discouraged) only used when SSH_KEY_PATH is not set
'use strict';

const fs = require('fs');

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Environment variable ${name} is required (see ops/legacy/README.md)`);
  }
  return value.trim();
}

/** Returns an ssh2 `connect()` config built only from environment variables. */
function sshConfig() {
  const config = {
    host: requireEnv('SSH_HOST'),
    port: Number.parseInt(process.env.SSH_PORT || '22', 10),
    username: requireEnv('SSH_USER'),
  };
  if (process.env.SSH_KEY_PATH) {
    config.privateKey = fs.readFileSync(process.env.SSH_KEY_PATH);
    if (process.env.SSH_KEY_PASSPHRASE) config.passphrase = process.env.SSH_KEY_PASSPHRASE;
  } else if (process.env.SSH_PASSWORD) {
    config.password = process.env.SSH_PASSWORD;
  } else {
    throw new Error('Set SSH_KEY_PATH (preferred) or SSH_PASSWORD (see ops/legacy/README.md)');
  }
  return config;
}

/** Absolute path of a local checkout used by the old upload scripts. */
function localRepoDir() {
  return requireEnv('LOCAL_REPO_DIR');
}

module.exports = { sshConfig, requireEnv, localRepoDir };
