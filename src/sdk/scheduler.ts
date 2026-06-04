export interface ScheduleHandle {
  stop(): void;
}

export interface Scheduler {
  interval(ms: number, fn: () => Promise<void>): ScheduleHandle;
  schedule(time: string, fn: () => Promise<void>): ScheduleHandle;
  stopAll(): void;
}
