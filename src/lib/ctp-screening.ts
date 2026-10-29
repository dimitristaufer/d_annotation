import { spawn } from "node:child_process";
import path from "node:path";

export type CtpScreeningLabel = "yes" | "no" | "unclear";
export type CtpLabelLookup = {
  frameId: "english_ge_90";
  runId: string;
  labels: Record<string, CtpScreeningLabel>;
  unlabeledRecordIds: string[];
};

export async function lookupCtpLabels(recordIds: string[]): Promise<CtpLabelLookup> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "query-index.py")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 32 * 1024 * 1024) {
        child.kill();
        rejectOnce(new Error("MSD1 label lookup exceeded its response size limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 64 * 1024) {
        const kept = chunk.subarray(0, 64 * 1024 - stderrBytes);
        stderr.push(kept);
        stderrBytes += kept.length;
      }
    });
    child.on("error", (error) => rejectOnce(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        rejectOnce(new Error(Buffer.concat(stderr).toString("utf8").trim() || `MSD1 label lookup exited (${code ?? "unknown"}).`));
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Partial<CtpLabelLookup>;
        const labels = result.labels;
        if (result.frameId !== "english_ge_90" || typeof result.runId !== "string"
            || !labels || typeof labels !== "object" || Array.isArray(labels)
            || !Object.values(labels).every((label) => label === "yes" || label === "no" || label === "unclear")
            || !Array.isArray(result.unlabeledRecordIds) || !result.unlabeledRecordIds.every((id) => typeof id === "string")) {
          throw new Error("MSD1 label lookup returned an invalid result.");
        }
        settled = true;
        resolve(result as CtpLabelLookup);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error("MSD1 label lookup returned invalid data."));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ action: "ctp_labels", record_ids: recordIds }));
  });
}
