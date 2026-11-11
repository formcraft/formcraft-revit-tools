import { RevitClientConnection } from "./SocketClient.js";
import { HOST, forgetInstance, notListening, probePort, readInstances, resolvePort, stalePortMessage } from "../fmc/connect.js";
import { backoffMs } from "../fmc/reconnect.js";
import { currentClient, documentRequired, queueFor } from "../fmc/fairqueue.js";
import { documentTarget, getChosen, revitTarget } from "../fmc/target.js";

// One fair queue per Revit. Calls to that Revit run one at a time. Clients take turns, so one batch
// cannot sit in front of everyone else. Two Revits still run side by side.

/**
 * The port the current call goes to (see resolvePort: the call's revit, the pane's REVIT_PORT, fmc_revit use, the only Revit).
 * A port taken from an instance file is probed first. A stale file is removed and the call fails with that reason,
 * instead of connecting and reporting ECONNRESET.
 */
export async function currentPort(): Promise<number> {
  const target = revitTarget.getStore();
  const chosen = getChosen();
  let last: Error | undefined;
  // A Revit that just restarted rewrites its instance file a moment later. Re-read between tries, and only
  // drop the file once it has stayed dead.
  for (let attempt = 0; attempt < 4; attempt++) {
    const instances = readInstances();
    const port = resolvePort(target, instances, process.env, chosen);
    if (!instances.some((i) => i.port === port)) return port;
    const verdict = await probePort(HOST, port, 300);
    if (verdict === "ok") return port;
    const owner = instances.find((i) => i.port === port);
    last = new Error(stalePortMessage(port, verdict, owner));
    if (attempt === 3) {
      if (owner) forgetInstance(owner);
      throw last;
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
  }
  throw last ?? new Error("Revit did not answer");
}

/**
 * 连接到Revit客户端并执行操作
 * Connects to the Revit this call targets and runs the operation.
 * @param operation 连接成功后要执行的操作函数
 * @returns 操作的结果
 */
export async function withRevitConnection<T>(
  operation: (client: RevitClientConnection) => Promise<T>
): Promise<T> {
  const port = await currentPort();
  const named = documentTarget.getStore();
  return queueFor(port).enqueue(currentClient(), named || "call", () => runOnPort(port, operation));
}

async function runOnPort<T>(port: number, operation: (client: RevitClientConnection) => Promise<T>): Promise<T> {
  const revitClient = new RevitClientConnection(HOST, port);
  revitClient.refreshPort = () => currentPort();

  try {
    // 连接到Revit客户端
    if (!revitClient.isConnected) {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          revitClient.socket.removeListener("connect", onConnect);
          revitClient.socket.removeListener("error", onError);
          resolve();
        };

        const onError = (error: any) => {
          revitClient.socket.removeListener("connect", onConnect);
          revitClient.socket.removeListener("error", onError);
          reject(new Error(notListening(port)));
        };

        revitClient.socket.on("connect", onConnect);
        revitClient.socket.on("error", onError);

        revitClient.connect();

        setTimeout(() => {
          revitClient.socket.removeListener("connect", onConnect);
          revitClient.socket.removeListener("error", onError);
          reject(new Error(notListening(port)));
        }, 5000);
      });
    }

    // 执行操作
    return await operation(revitClient);
  } finally {
    // 断开连接
    revitClient.disconnect();
  }
}
