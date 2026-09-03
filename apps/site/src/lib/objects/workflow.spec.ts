import { describe, expect, it } from 'vitest';
import {
  taskKanbanColumnDefinitions,
  taskKanbanLaneDefinitions,
} from './workflow';

describe('task workflow board lanes', () => {
  it('groups every detailed kanban column into fewer display lanes', () => {
    const detailedColumns = taskKanbanColumnDefinitions.map(
      (definition) => definition.value,
    );
    const laneColumns = taskKanbanLaneDefinitions.flatMap((lane) => [
      ...lane.columns,
    ]);

    expect(taskKanbanLaneDefinitions.length).toBeLessThan(
      taskKanbanColumnDefinitions.length,
    );
    expect(laneColumns).toHaveLength(new Set(laneColumns).size);
    expect([...laneColumns].sort()).toEqual([...detailedColumns].sort());
  });
});
