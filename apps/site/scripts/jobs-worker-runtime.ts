type StartableTaskRunner = {
  start(): Promise<void>;
};

/** The task worker claims tasks only; schedule polling belongs to its own pod. */
export async function startTaskWorker(
  taskRunner: StartableTaskRunner,
): Promise<void> {
  await taskRunner.start();
}
