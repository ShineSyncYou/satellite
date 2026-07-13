import { spawn } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";
function startProcess(label, scriptText, color) {
  const command = isWindows ? `npm run ${scriptText}` : "npm";
  const commandArgs = isWindows ? [] : ["run", ...scriptText.split(" ")];
  const child = spawn(command, commandArgs, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: isWindows,
    env: process.env,
  });

  const prefix = `${color}[${label}]\x1b[0m`;

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`${prefix} ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`${prefix} ${chunk}`);
  });

  child.on("error", (error) => {
    process.stderr.write(`${prefix} failed to start: ${error.message}\n`);
  });

  return child;
}

const processes = [
  startProcess("server", "server", "\x1b[36m"),
  startProcess("vite", "dev -- --host 127.0.0.1", "\x1b[35m"),
];

let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of processes) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 800);
}

for (const child of processes) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      process.stderr.write(`\nOne child process exited with signal ${signal}, shutting down all services.\n`);
      stopAll(1);
      return;
    }
    if (code && code !== 0) {
      process.stderr.write(`\nOne child process exited with code ${code}, shutting down all services.\n`);
      stopAll(code);
    }
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
