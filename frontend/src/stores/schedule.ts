import { create } from 'zustand';

// Phase 4 wires upcoming / recurring / history here.
type ScheduleState = Record<string, never>;

export const useScheduleStore = create<ScheduleState>()(() => ({}));
