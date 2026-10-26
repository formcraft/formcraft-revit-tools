import * as net from "net";
import fs from "fs";
import path from "path";
import { appendJobEvent, jobFiles, jobResult, lastHeartbeatMs } from "../fmc/jobs.js";
import { WRITE_COMMANDS, liveLockVerdict, loadConfig } from "../fmc/policy.js";
import { documentTarget } from "../fmc/target.js";
import { aiGate } from "../fmc/aigate.js";
import { retryWhileBusy } from "../fmc/busy.js";

export class RevitClientConnection {
  host: string;
  port: number;
  socket: net.Socket;
  isConnected: boolean = false;
  responseCallbacks: Map<string, (response: string) => void> = new Map();
  buffer: string = "";

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
    this.socket = new net.Socket();
    this.setupSocketListeners();
  }

  private setupSocketListeners(): void {
    this.socket.on("connect", () => {
      this.isConnected = true;
    });

    this.socket.on("data", (data) => {
      // 将接收到的数据添加到缓冲区
      const dataString = data.toString();
      this.buffer += dataString;

      // 尝试解析完整的JSON响应
      this.processBuffer();
    });

    this.socket.on("close", () => {
      this.isConnected = false;
    });

    this.socket.on("error", (error) => {
      console.error("RevitClientConnection error:", error);
      this.isConnected = false;
    });
  }

  private processBuffer(): void {
    try {
      // 尝试解析JSON
      const response = JSON.parse(this.buffer);
      // 如果成功解析，处理响应并清空缓冲区
      this.handleResponse(this.buffer);
      this.buffer = "";
    } catch (e) {
      // 如果解析失败，可能是因为数据不完整，继续等待更多数据
    }
  }

  public connect(): boolean {
    if (this.isConnected) {
      return true;
    }

    try {
      this.socket.connect(this.port, this.host);
      return true;
    } catch (error) {
      console.error("Failed to connect:", error);
      return false;
    }
  }

  public disconnect(): void {
    this.socket.end();
    this.isConnected = false;
  }

  private generateRequestId(): string {
    return Date.now().toString() + Math.random().toString().substring(2, 8);
  }

  private handleResponse(responseData: string): void {
    try {
      const response = JSON.parse(responseData);
      // 从响应中获取ID
      const requestId = response.id || "default";

      const callback = this.responseCallbacks.get(requestId);
      if (callback) {
        callback(responseData);
        this.responseCallbacks.delete(requestId);
      }
    } catch (error) {
      console.error("Error parsing response:", error);
    }
  }

  /**
   * Sends a command to Revit. Model-changing commands first pass the Formcraft live-model lock
   * (server/src/fmc/policy.ts): they are refused when the active document is a live project model.
   * The lock fails closed: if the active document cannot be read, the command is not sent.
   */
  public async sendCommand(command: string, params: any = {}, timeoutMs: number = 120000): Promise<any> {
    if (WRITE_COMMANDS.has(command)) {
      const { config } = loadConfig();
      if (config.live_model_lock) {
        let info: any;
        try {
          info = await this.sendRaw("fmc_document_info", {});
        } catch (error) {
          throw new Error(
            "FMC live-model lock: could not read the active document, so the command was not sent. " +
              "Is the Formcraft command set (fmc_document_info) installed? " +
              (error instanceof Error ? error.message : String(error))
          );
        }
        const verdict = liveLockVerdict(info?.active, config);
        if (!verdict.ok) {
          // The lock's one new case: the AI-assisted modeller, Off unless the kit rulebook and the BIM Manager allow it.
          const gate = await aiGate(command, params, info?.active, config, (c, p) => this.sendRaw(c, p, 60000));
          // A person sees one plain line (USER_LINE), never the lock's wording; fmc_ai status has the detail.
          if (!gate.ok || !gate.run) throw new Error(gate.user ?? [...verdict.reasons, gate.reason].filter(Boolean).join(" "));
          return gate.run(() => this.sendRaw(command, params, timeoutMs));
        }
      }
    }
    return this.sendRaw(command, params, timeoutMs);
  }

  /**
   * F-064 long-job route for one call: no fixed cap while Revit works on it. The call waits as long as Revit's heartbeats
   * for its job (FMC_Jobs_Revit.jsonl, one a minute) are fresh, up to `ceilingMs` overall; it fails with a clear message
   * when the heartbeats stop (Revit closed or crashed) or the ceiling passes. If the socket answer is lost but Revit wrote
   * the job's result to the late-results file itself, that result is the answer. With the MCP answer limit on, the call
   * still answers "still running" with its job id (JobStillRunning) like any other.
   * Note: Revit's heartbeat comes from a timer, so it says "the job is waiting or running", not that Revit's API thread
   * is free; a Revit held by another command keeps heartbeating, and the ceiling ends that wait.
   */
  public sendLong(command: string, params: any = {}, opts: LongJobOptions): Promise<any> {
    return this.sendRaw(command, params, opts.ceilingMs, opts);
  }

  public sendRaw(command: string, params: any = {}, timeoutMs: number = 120000, long?: LongJobOptions): Promise<any> {
    // F-072: an earlier command that outlived its wait still holds Revit, and the add-in says so at once
    // ([FMC-BRIDGE-BUSY]): wait and send again while that job's heartbeats are fresh, up to this call's own limit (the
    // answer limit, when the MCP server's is on), instead of failing
    const soft = softTimeoutMs();
    return retryWhileBusy(() => this.sendOnce(command, params, timeoutMs, long),
      { command, ceilingMs: soft > 0 ? Math.min(soft, timeoutMs) : timeoutMs, heartbeatMs: (job) => lastHeartbeatMs(job) });
  }

  private sendOnce(command: string, params: any = {}, timeoutMs: number = 120000, long?: LongJobOptions): Promise<any> {
    // The call's document target goes with every command (the live-model lock's document check included), unless the
    // command names its own document.
    const document = documentTarget.getStore();
    if (document && params && typeof params === "object" && !Array.isArray(params) && !("document" in params)) params = { ...params, document };
    return new Promise((resolve, reject) => {
      try {
        if (!this.isConnected) {
          this.connect();
        }

        // 生成请求ID
        const requestId = this.generateRequestId();

        // 创建符合JSON-RPC标准的请求对象
        const commandObj = {
          jsonrpc: "2.0",
          method: command,
          params: params,
          id: requestId,
        };

        // 存储回调函数
        this.responseCallbacks.set(requestId, (responseData) => {
          try {
            const response = JSON.parse(responseData);
            if (response.error) {
              reject(
                new Error(response.error.message || "Unknown error from Revit")
              );
            } else {
              resolve(response.result);
            }
          } catch (error) {
            if (error instanceof Error) {
              reject(new Error(`Failed to parse response: ${error.message}`));
            } else {
              reject(new Error(`Failed to parse response: ${String(error)}`));
            }
          }
        });

        // 发送命令
        const commandString = JSON.stringify(commandObj);
        this.socket.write(commandString);

        // F-022/F-030: answer before the client's own 60 s cutoff. Every call is a job (its id is the request id); one
        // that passes the answer limit replies "still running" with its job id, keeps waiting in the background, and its
        // final answer goes to the late-results file with the job id, for fmc_job status / result.
        const soft = softTimeoutMs();
        const started = new Date().toISOString();
        let settled = false;
        let stillRunning = false;
        const finish = this.responseCallbacks.get(requestId)!;
        this.responseCallbacks.set(requestId, (data) => {
          if (settled) { logLateResult(command, requestId, data); this.responseCallbacks.delete(requestId); return; }
          settled = true;
          finish(data);
        });
        if (soft > 0 && soft < timeoutMs) {
          setTimeout(() => {
            if (settled || !this.responseCallbacks.has(requestId)) return;
            settled = true;
            stillRunning = true;
            appendJobEvent({ job: requestId, event: "running", command, port: this.port, started });
            reject(new JobStillRunning(requestId, command, Math.round(soft / 1000)));
          }, soft);
        }

        // 设置超时: no answer at all. A job that already answered "still running" waits up to FMC_JOB_MAX_MS for its result.
        const hard = (after: number, extended: boolean) => {
          const t = setTimeout(() => {
            if (!this.responseCallbacks.has(requestId)) return;
            const max = jobMaxMs();
            if (stillRunning && !extended && max > timeoutMs) { hard(max - timeoutMs, true); return; }
            // F-064: no fixed cap: while Revit's heartbeats for this job are fresh, keep waiting (Revit keeps the answer anyway)
            if (stillRunning && Date.now() - lastHeartbeatMs(requestId) < HEARTBEAT_FRESH_MS) { hard(HEARTBEAT_FRESH_MS, true); return; }
            this.responseCallbacks.delete(requestId);
            if (!settled) { settled = true; reject(new Error(`[FMC-BRIDGE-TIMEOUT] Revit didn't answer ${command} in ${Math.round(timeoutMs / 1000)} s (job ${requestId}).`)); }
            else appendJobEvent({ job: requestId, event: "gave_up", command, after_s: Math.round((Date.now() - Date.parse(started)) / 1000) });
          }, after);
          if (extended) t.unref?.();
        };
        if (long) {
          // F-064: the long-job route: Revit's heartbeats decide, not a fixed time
          const stale = long.staleMs ?? HEARTBEAT_FRESH_MS;
          const poll = Math.max(1, long.pollMs ?? 15000);
          const t0 = Date.now();
          const fail = (message: string) => {
            if (settled || !this.responseCallbacks.has(requestId)) return;
            settled = true;
            this.responseCallbacks.delete(requestId);
            appendJobEvent({ job: requestId, event: "gave_up", command, after_s: Math.round((Date.now() - t0) / 1000) });
            reject(new Error(message));
          };
          const check = () => {
            // answered, or answered "still running" (the MCP limit): Revit keeps the late answer as for any job
            if (settled || !this.responseCallbacks.has(requestId)) return;
            // Revit keeps a long job's answer itself: if the socket lost it, take it from there
            const kept = jobResult(requestId);
            if (kept.found && kept.result && typeof kept.result === "object") {
              this.responseCallbacks.get(requestId)?.(JSON.stringify({ ...(kept.result as object), id: requestId }));
              return;
            }
            const now = Date.now();
            const hb = lastHeartbeatMs(requestId);
            if (now - t0 >= long.ceilingMs)
              return fail(`[FMC-BRIDGE-CEILING] ${command} didn't finish in ${long.ceilingMs >= 60000 ? `${Math.round(long.ceilingMs / 60000)} min` : `${Math.round(long.ceilingMs / 1000)} s`} (job ${requestId}, ` +
                (hb ? `last heartbeat ${Math.round((now - hb) / 1000)} s ago` : "no heartbeat from Revit") +
                `): Revit is still busy (another command holding it?) or blocked by a dialog. fmc_job status ${requestId} follows it.`);
            if (now - Math.max(hb, t0) >= stale)
              return fail(`[FMC-BRIDGE-NO-HEARTBEAT] ${command}: Revit stopped sending heartbeats for job ${requestId} ` +
                (hb ? `(last one ${Math.round((now - hb) / 1000)} s ago)` : `(none in ${Math.round((now - t0) / 1000)} s)`) +
                ": Revit may have closed or crashed, or its add-in is too old to send them.");
            setTimeout(check, Math.min(poll, Math.max(1, long.ceilingMs - (now - t0))));
          };
          setTimeout(check, Math.min(poll, long.ceilingMs));
        } else hard(timeoutMs, false);
      } catch (error) {
        reject(error);
      }
    });
  }
}

let softTimeoutOn = false;
/** The MCP (stdio) server turns this on: its clients cut a call at about 60 s. The pane's CLI waits longer and leaves it off. */
export function enableSoftTimeout() { softTimeoutOn = true; }

/** Soft timeout (ms) before a tool replies "still queued"; FMC_SOFT_TIMEOUT_MS overrides, 0 turns it off. */
export function softTimeoutMs(): number {
  if (!softTimeoutOn) return 0;
  const v = Number(process.env.FMC_SOFT_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 50000;
}

/** The long-job route (sendLong): the overall ceiling, how old Revit's last heartbeat may be (default 3 min), how often to look. */
export interface LongJobOptions { ceilingMs: number; staleMs?: number; pollMs?: number }

/** A heartbeat younger than this (ms) means the job is still alive in Revit (Revit writes one a minute). */
export const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

/** How long a job that answered "still running" is waited for before heartbeats decide (ms): FMC_JOB_MAX_MS, default 35 min. */
export function jobMaxMs(): number {
  const v = Number(process.env.FMC_JOB_MAX_MS);
  return Number.isFinite(v) && v > 0 ? v : 35 * 60 * 1000;
}

/**
 * A call that passed the answer limit: still running in Revit, not failed (F-030). Tools show this message; the
 * job id is what fmc_job status / result / cancel take.
 */
export class JobStillRunning extends Error {
  readonly code = "FMC-JOB-RUNNING";
  constructor(readonly job: string, readonly command: string, readonly seconds: number) {
    super(
      `[FMC-JOB-RUNNING] ${command} is still running in Revit after ${seconds} s (not failed). Job ${job}. ` +
        `Don't send it again: ask fmc_job status ${job}, then fmc_job result ${job} once it has finished ` +
        `(fmc_job cancel ${job} asks Revit to stop it at its next check). The answer is also kept in ${lateResultsPath()}.`);
    this.name = "JobStillRunning";
  }
}

export function lateResultsPath(): string {
  return jobFiles().late;
}

/** A result that arrived after the tool had already replied: kept with its job id, one JSON line each, never dropped. */
export function logLateResult(command: string, id: string, data: string) {
  try {
    let result: unknown = data;
    try { result = JSON.parse(data); } catch { /* keep the raw text */ }
    fs.mkdirSync(path.dirname(lateResultsPath()), { recursive: true });
    fs.appendFileSync(lateResultsPath(), JSON.stringify({ at: new Date().toISOString(), command, id, job: id, result }) + "\n");
  } catch {
    // logging must never block the work
  }
}
