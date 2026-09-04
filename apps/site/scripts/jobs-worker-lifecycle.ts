type StoppableRunner = {
  stop(): Promise<void>;
};

/** Drain both runners before a signal handler lets the worker exit. */
export async function drainJobWorkerRunners({
  scheduleRunner,
  taskRunner,
}: {
  readonly scheduleRunner: StoppableRunner;
  readonly taskRunner: StoppableRunner;
}): Promise<void> {
  await Promise.allSettled([scheduleRunner.stop(), taskRunner.stop()]);
}
