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

export type NoShowReason = 'customer_cancelled' | 'staff_marked';

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
  noShowReason: NoShowReason | null; // quem causou o status 'no_show'
  wasTransferred: boolean; // true assim que é transferida uma vez, nunca reposto
  customerOnTheWay: boolean; // o cliente avisou que está a caminho
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

export type AppointmentStatus = 'scheduled' | 'cancelled';

// Espelho, visível à equipa, do agendamento privado que o cliente cria em
// users/{uid}/appointments — só existe para a localização piloto.
export interface Appointment {
  id: string;
  customerUid: string;
  serviceName: string;
  date: number; // epoch ms, dia do agendamento
  time: string;
  createdAt: number; // epoch ms, quando foi marcado
  status: AppointmentStatus;
}
