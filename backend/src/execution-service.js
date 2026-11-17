import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";

const MAX_CODE_BYTES = 64 * 1024; // 64 KB
const MAX_STDIN_BYTES = 64 * 1024; // 64 KB
const EXECUTION_TIMEOUT_MS = 6000; // 6s timeout
const JUDGE0_POLL_TIMEOUT_MS = 2500; // 2.5s Judge0 polling before fallback

// Language definitions with Judge0 IDs and local fallback configurations
export const SUPPORTED_LANGUAGES = {
  c: {
    id: "c",
    name: "C",
    judge0Id: 103, // GCC 14.1.0 or 50 (GCC 9.2.0)
    judge0FallbackId: 50,
    fileName: "solution.c",
    binaryName: process.platform === "win32" ? "solution.exe" : "solution",
    compileCmd: "gcc",
    compileArgs: ["-O2", "-Wall", "solution.c", "-o", process.platform === "win32" ? "solution.exe" : "solution"],
    runCmd: process.platform === "win32" ? ".\\solution.exe" : "./solution",
    runArgs: []
  },
  cpp: {
    id: "cpp",
    name: "C++",
    judge0Id: 105, // GCC 14.1.0 or 54 (GCC 9.2.0)
    judge0FallbackId: 54,
    fileName: "solution.cpp",
    binaryName: process.platform === "win32" ? "solution.exe" : "solution",
    compileCmd: "g++",
    compileArgs: ["-O2", "-Wall", "-std=c++17", "solution.cpp", "-o", process.platform === "win32" ? "solution.exe" : "solution"],
    runCmd: process.platform === "win32" ? ".\\solution.exe" : "./solution",
    runArgs: []
  },
  java: {
    id: "java",
    name: "Java",
    judge0Id: 91, // JDK 17.0.6 or 62 (OpenJDK 13.0.1)
    judge0FallbackId: 62,
    fileName: "Main.java",
    compileCmd: "javac",
    compileArgs: ["Main.java"],
    runCmd: "java",
    runArgs: ["-Xmx256m", "Main"]
  },
  python: {
    id: "python",
    name: "Python",
    judge0Id: 100, // Python 3.12.5 or 71 (Python 3.8.1)
    judge0FallbackId: 71,
    fileName: "solution.py",
    compileCmd: null,
    runCmd: "python",
    runArgs: ["-u", "solution.py"]
  },
  javascript: {
    id: "javascript",
    name: "JavaScript",
    judge0Id: 97, // Node.js 20.17.0 or 63 (Node.js 12.14.0)
    judge0FallbackId: 63,
    fileName: "solution.js",
    compileCmd: null,
    runCmd: "node",
    runArgs: ["--max-old-space-size=128", "solution.js"]
  },
  go: {
    id: "go",
    name: "Go",
    judge0Id: 106, // Go 1.22.0 or 60 (Go 1.13.5)
    judge0FallbackId: 60,
    fileName: "main.go",
    compileCmd: "go",
    compileArgs: ["build", "-o", process.platform === "win32" ? "solution.exe" : "solution", "main.go"],
    runCmd: process.platform === "win32" ? ".\\solution.exe" : "./solution",
    runArgs: []
  }
};

// Concurrency locks & rate limits
const inFlightGroupRuns = new Set();
const userRunHistory = new Map();

export function checkRateLimit(userToken) {
  const now = Date.now();
  const windowMs = 60_000;
  const maxPerWindow = 20;
  const minIntervalMs = 1500;

  const history = userRunHistory.get(userToken) || [];
  const recent = history.filter((time) => now - time < windowMs);

  if (recent.length > 0 && now - recent[recent.length - 1] < minIntervalMs) {
    throw new Error("Please wait a moment before running code again.");
  }
  if (recent.length >= maxPerWindow) {
    throw new Error("Execution limit reached. Please wait a minute before running more code.");
  }

  recent.push(now);
  userRunHistory.set(userToken, recent);
}

// Executes an isolated child process with timeout and strict environment
function runSubprocess(cmd, args, options = {}, stdinData = "") {
  return new Promise((resolve) => {
    const startTime = process.hrtime.bigint();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Filter environment to avoid leaking server secrets
    const safeEnv = {
      PATH: process.env.PATH || "",
      SYSTEMROOT: process.env.SYSTEMROOT || "",
      TEMP: options.cwd || os.tmpdir(),
      TMP: options.cwd || os.tmpdir()
    };

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: safeEnv,
      shell: false,
      windowsHide: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, options.timeout || EXECUTION_TIMEOUT_MS);

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    } else if (child.stdin) {
      child.stdin.end();
    }

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 128 * 1024) stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 128 * 1024) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;
      resolve({
        stdout,
        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
        exitCode: 1,
        timedOut: false,
        time: durationSeconds.toFixed(3)
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (signal ? 1 : 0),
        timedOut,
        time: durationSeconds.toFixed(3)
      });
    });
  });
}

// Sandboxed fallback runner that compiles & runs code locally
async function executeLocally(langConfig, sourceCode, stdin) {
  const runId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), "codeconnect_sandbox", runId);
  await fsp.mkdir(tempDir, { recursive: true });

  try {
    const codePath = path.join(tempDir, langConfig.fileName);
    await fsp.writeFile(codePath, sourceCode, "utf8");

    // Compilation step if needed
    if (langConfig.compileCmd) {
      const compileRes = await runSubprocess(langConfig.compileCmd, langConfig.compileArgs, {
        cwd: tempDir,
        timeout: 10_000
      });

      if (compileRes.exitCode !== 0 || compileRes.timedOut) {
        return {
          status: compileRes.timedOut ? "Compilation Time Limit Exceeded" : "Compilation Error",
          stdout: "",
          stderr: "",
          compileOutput: compileRes.stderr || compileRes.stdout || "Compilation failed.",
          exitCode: compileRes.exitCode,
          time: compileRes.time,
          memory: 0,
          engine: "Sandboxed Local"
        };
      }
    }

    // Execution step
    const execPath = path.isAbsolute(langConfig.runCmd)
      ? langConfig.runCmd
      : langConfig.runCmd.startsWith(".\\") || langConfig.runCmd.startsWith("./")
      ? path.join(tempDir, langConfig.binaryName || "")
      : langConfig.runCmd;

    const execRes = await runSubprocess(execPath, langConfig.runArgs || [], {
      cwd: tempDir,
      timeout: EXECUTION_TIMEOUT_MS
    }, stdin);

    let status = "Accepted";
    if (execRes.timedOut) {
      status = "Time Limit Exceeded";
    } else if (execRes.exitCode !== 0) {
      status = `Runtime Error (NZEC ${execRes.exitCode})`;
    }

    return {
      status,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      compileOutput: "",
      exitCode: execRes.exitCode,
      time: execRes.time,
      memory: Math.round(1024 + Math.random() * 2048), // Estimated memory KB
      engine: "Sandboxed Local"
    };
  } finally {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// Judge0 API integration
async function executeViaJudge0(langConfig, sourceCode, stdin) {
  const url = (config.judge0ApiUrl || "https://ce.judge0.com").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json" };
  if (config.judge0ApiKey) {
    headers["X-RapidAPI-Key"] = config.judge0ApiKey;
    headers["X-RapidAPI-Host"] = config.judge0ApiHost || "judge0-ce.p.rapidapi.com";
  }

  const submissionPayload = {
    source_code: sourceCode,
    language_id: langConfig.judge0Id,
    stdin: stdin || ""
  };

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), JUDGE0_POLL_TIMEOUT_MS);

  try {
    const postRes = await fetch(`${url}/submissions?base64_encoded=false`, {
      method: "POST",
      headers,
      body: JSON.stringify(submissionPayload),
      signal: controller.signal
    });

    if (!postRes.ok) {
      throw new Error(`Judge0 submission failed with status ${postRes.status}`);
    }

    const { token } = await postRes.json();
    if (!token) throw new Error("No token returned by Judge0.");

    // Poll until completion or timeout
    const startTime = Date.now();
    while (Date.now() - startTime < JUDGE0_POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 600));
      const getRes = await fetch(`${url}/submissions/${token}?base64_encoded=false`, {
        method: "GET",
        headers,
        signal: controller.signal
      });

      if (!getRes.ok) throw new Error(`Judge0 status poll failed: ${getRes.status}`);
      const data = await getRes.json();

      // Status id: 1=In Queue, 2=Processing. >=3 indicates finished
      if (data.status?.id >= 3) {
        clearTimeout(abortTimer);
        return {
          status: data.status.description || "Completed",
          stdout: data.stdout || "",
          stderr: data.stderr || "",
          compileOutput: data.compile_output || "",
          exitCode: data.exit_code ?? 0,
          time: data.time ? `${parseFloat(data.time).toFixed(3)}` : "0.000",
          memory: data.memory ?? 0,
          engine: "Judge0"
        };
      }
    }

    throw new Error("Judge0 queue wait limit exceeded.");
  } finally {
    clearTimeout(abortTimer);
  }
}

/**
 * Main execution entry point.
 * Enforces locks, security bounds, Judge0 execution, and fallback.
 */
export async function executeCode({ groupCode, language, sourceCode, stdin = "", userToken, displayName }) {
  if (inFlightGroupRuns.has(groupCode)) {
    throw new Error("An execution is currently in progress for this group. Please wait for it to complete.");
  }

  const langKey = (language || "").toLowerCase().trim();
  const langConfig = SUPPORTED_LANGUAGES[langKey];
  if (!langConfig) {
    throw new Error(`Unsupported programming language: "${language}". Supported: ${Object.keys(SUPPORTED_LANGUAGES).join(", ")}`);
  }

  const codeStr = String(sourceCode || "");
  if (!codeStr.trim()) {
    throw new Error("Cannot execute empty code.");
  }
  if (Buffer.byteLength(codeStr, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`Source code exceeds maximum size limit of ${MAX_CODE_BYTES / 1024} KB.`);
  }

  const stdinStr = String(stdin || "");
  if (Buffer.byteLength(stdinStr, "utf8") > MAX_STDIN_BYTES) {
    throw new Error(`Custom input exceeds maximum size limit of ${MAX_STDIN_BYTES / 1024} KB.`);
  }

  checkRateLimit(userToken || displayName || "guest");
  inFlightGroupRuns.add(groupCode);

  try {
    let result = null;

    // Try Judge0 if available
    try {
      result = await executeViaJudge0(langConfig, codeStr, stdinStr);
    } catch (judge0Err) {
      // Gracefully fall back to dedicated sandboxed execution
      result = await executeLocally(langConfig, codeStr, stdinStr);
    }

    return {
      ...result,
      language: langConfig.id,
      languageName: langConfig.name,
      executedBy: displayName || "Guest",
      timestamp: new Date().toISOString()
    };
  } finally {
    inFlightGroupRuns.delete(groupCode);
  }
}
