import { config } from "./config.js";

const MAX_CODE_BYTES = 64 * 1024; // 64 KB
const MAX_STDIN_BYTES = 64 * 1024; // 64 KB
const JUDGE0_POLL_TIMEOUT_MS = 20_000;

// Judge0 language IDs
export const SUPPORTED_LANGUAGES = {
  c: {
    id: "c",
    name: "C",
    judge0Id: 103
  },
  cpp: {
    id: "cpp",
    name: "C++",
    judge0Id: 105
  },
  java: {
    id: "java",
    name: "Java",
    judge0Id: 91
  },
  python: {
    id: "python",
    name: "Python",
    judge0Id: 100
  },
  javascript: {
    id: "javascript",
    name: "JavaScript",
    judge0Id: 97
  },
  go: {
    id: "go",
    name: "Go",
    judge0Id: 106
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
 * Enforces locks, security bounds, and external Judge0 execution.
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
    let result;
    try {
      result = await executeViaJudge0(langConfig, codeStr, stdinStr);
    } catch (error) {
      const unavailable = new Error("Code execution service is temporarily unavailable. Please try again later.", {
        cause: error
      });
      unavailable.code = "JUDGE0_UNAVAILABLE";
      throw unavailable;
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
