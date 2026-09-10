import { spawn } from "node:child_process";
import process from "node:process";

function terminateProcessTree(child) {
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false
      });
      killer.on("error", () => {});
      return;
    }
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Run a stdin-driven child with bounded output and a tree-wide hard timeout.
 * Rejects on a non-zero exit so callers can preserve their existing contract.
 * Output stays as buffers until the stream has ended, preventing a UTF-8
 * character split between chunks from being decoded as a replacement character.
 */
export function execFileWithInput(command, args, input, {
  cwd,
  timeoutMs = 120_000,
  env = {},
  maxOutputBytes = 8 * 1024 * 1024
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(reject, new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    timer.unref?.();

    const collect = (target) => (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        terminateProcessTree(child);
        finish(reject, new Error(`Command output exceeded ${maxOutputBytes} bytes: ${command}`));
        return;
      }
      target.push(buffer);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) finish(resolve, output);
      else finish(reject, new Error(output.stderr || output.stdout || `Command failed with exit code ${code}`));
    });
    // A worker may exit between the writable check and stdin.end(). Consuming
    // EPIPE prevents that expected race from terminating the MCP process.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
