export type StaffRole = 'agent' | 'manager';

export interface StaffProfile {
  uid: string;
  name: string;
  role: StaffRole;
  institutionId: string;
  branchId: string;
  counterId?: string; // só para agentes
}

export type TicketStatus = 'waiting' | 'called' | 'serving' | 'done' | 'no_show';

export interface Ticket {
  id: string;
  code: string;
  service: string;
  priority: boolean;
  status: TicketStatus;
  counterId: string | null;
  createdAt: number; // epoch ms
  calledAt: number | null;
  doneAt: number | null;
  transferredToCounterId: string | null; // reservado para um balcão específico
}

export type CounterStatus = 'available' | 'serving' | 'paused';

export interface Counter {
  id: string;
  label: string;
  status: CounterStatus;
  currentTicketId: string | null;
  agentName: string | null;
}

export interface LiveBoardEntry {
  code: string;
  counterLabel: string;
}

export interface LiveBoard {
  current: LiveBoardEntry | null;
  history: LiveBoardEntry[];
  updatedAt: number | null;
}

export interface Branch {
  id: string;
  name: string;
}
