import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { getRuntimePaths } from "./runtime-paths.js";

const execFileAsync = promisify(execFile);

export interface ClaudeAuthStatus {
  claudePath: string;
  claudeBinaryExists: boolean;
  keychainItemFound: boolean;
  keychainCheckError?: string;
}

export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const runtimePaths = getRuntimePaths();
  const claudePath = runtimePaths.claudeBinaryPath;
  const claudeBinaryExists = existsSync(claudePath);

  // Check for Claude Code keychain item (no secret output)
  let keychainItemFound = false;
  let keychainCheckError: string | undefined;
  const homeDir = runtimePaths.homeDir;
  const loginKeychain = `${homeDir}/Library/Keychains/login.keychain-db`;

  const attempts: string[][] = [
    ["find-generic-password", "-s", "Claude Code-credentials"],
  ];

  if (existsSync(loginKeychain)) {
    attempts.push(["find-generic-password", "-s", "Claude Code-credentials", loginKeychain]);
  }

  const errors: string[] = [];

  for (const args of attempts) {
    try {
      await execFileAsync(
        "/usr/bin/security",
        args,
        {
          timeout: 2000,
          env: {
            ...process.env,
            HOME: homeDir,
          },
        }
      );
      keychainItemFound = true;
      keychainCheckError = undefined;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(message);
    }
  }

  if (!keychainItemFound && errors.length > 0) {
    keychainCheckError = errors.join(" | ");
  }

  return {
    claudePath,
    claudeBinaryExists,
    keychainItemFound,
    keychainCheckError: keychainItemFound ? undefined : keychainCheckError,
  };
}
