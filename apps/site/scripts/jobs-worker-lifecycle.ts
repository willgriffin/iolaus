type StoppableRunner = {
  stop(): Promise<void>;
};

/** Drain both runners before a signal handler lets the worker exit. */
export async function drainJobWorkerRunners({
  scheduleRunner,
  stopHeartbeat = () => {},
  taskRunner,
}: {
  readonly scheduleRunner: StoppableRunner;
  readonly stopHeartbeat?: () => void;
  readonly taskRunner: StoppableRunner;
}): Promise<void> {
  await Promise.allSettled([scheduleRunner.stop(), taskRunner.stop()]);
  stopHeartbeat();
}
