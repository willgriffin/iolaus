import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';

/** Registers a distinct `Task` class under a foreign package name. */
export async function registerForeignTask(): Promise<void> {
  class Task extends SmrtObject {}
  ObjectRegistry.register(Task, {
    name: 'Task',
    packageName: '@example/foreign',
  });
}
