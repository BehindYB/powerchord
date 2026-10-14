/** Shared hub data types. Browser-safe: no Node.js dependencies. */

export type TaskStatus = 'open' | 'in_progress' | 'done';

export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'done'];

export interface HubTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Latest progress or result summary, usually written by the agent that worked on it. */
  summary: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface HubNote {
  id: string;
  title: string;
  content: string;
  updatedBy: string;
  updatedAt: number;
}

export interface HubSnapshot {
  tasks: HubTask[];
  notes: HubNote[];
}
