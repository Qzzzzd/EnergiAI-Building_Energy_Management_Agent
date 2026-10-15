#!/usr/bin/env node
import { spawn } from 'node:child_process';

const executable = process.env.BE_CODEX_REAL_BIN || 'codex';
const appArmorProfile = process.env.BE_CODEX_APPARMOR_PROFILE?.trim();
if (appArmorProfile && !/^[A-Za-z0-9_.-]{1,128}$/.test(appArmorProfile)) {
  process.stderr.write('BE_CODEX_APPARMOR_PROFILE is invalid\n');
  process.exit(2);
}
const launcher = appArmorProfile ? '/usr/bin/aa-exec' : executable;
const launcherArguments = appArmorProfile
  ? ['-p', appArmorProfile, '--', executable, ...process.argv.slice(2)]
  : process.argv.slice(2);
const child = spawn(launcher, launcherArguments, {
  detached: true,
  stdio: 'inherit',
  env: process.env,
});

let stopping = false;
const stop = (signal) => {
  if (stopping || child.pid === undefined) return;
  stopping = true;
  try {
    process.kill(-child.pid, signal);
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 2000);
  timer.unref();
};

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('error', (error) => {
  process.stderr.write(`codex launcher failed: ${error.message}\n`);
  process.exitCode = 127;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
