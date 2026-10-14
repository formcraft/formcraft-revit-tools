import { RevitClientConnection } from "./SocketClient.js";
import { HOST, notListening, readInstances, resolvePort } from "../fmc/connect.js";
import { getChosen, revitTarget } from "../fmc/target.js";

// One queue per Revit: calls to the same Revit run one at a time (its API is single-threaded), calls to two Revits
// run side by side, so two projects can be automated at once.
const queues = new Map<number, Promise<void>>();

/** The port the current call goes to (see resolvePort: the call's revit, the pane's REVIT_PORT, fmc_revit use, the only Revit). */
export function currentPort(): number {
  return resolvePort(revitTarget.getStore(), readInstances(), process.env, getChosen());
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
  const port = currentPort();
  const previous = queues.get(port) ?? Promise.resolve();
  let release: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.then(() => mine);
  queues.set(port, chain);
  await previous;

  const revitClient = new RevitClientConnection(HOST, port);

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
    release!();
    if (queues.get(port) === chain) queues.delete(port); // nobody queued behind this call
  }
}
