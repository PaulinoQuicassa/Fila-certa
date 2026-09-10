export type StaffRole = 'agent' | 'manager' | 'director';

export interface StaffProfile {
  uid: string;
  name: string;
  role: StaffRole;
  institutionId: string;
  branchId: string | null; // null só para director -- vê a instituição toda, não uma filial
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
  customerArrivedAt: number | null; // o cliente confirmou que já chegou ao local
  customerDelayReportedAt: number | null; // o cliente avisou que vai demorar mais um pouco
}

export type DirectorPeriod = 'hoje' | '7d' | '30d';

export interface DirectorKpis {
  avgWaitMinutes: number | null;
  avgWaitTrendPct: number | null;
  avgSatisfaction: number | null;
  avgSatisfactionTrendPct: number | null;
  abandonmentPct: number | null;
  abandonmentTrendPct: number | null;
  completedCount: number;
  completedTrendPct: number | null;
}

export interface DirectorTrendPoint {
  label: string;
  avgWaitMinutes: number | null;
}

export interface DirectorBenchmarkRow {
  branchId: string;
  branchName: string;
  avgWaitMinutes: number | null;
  avgSatisfaction: number | null;
  abandonmentPct: number;
  score: number;
}

export type AlertSeverity = 'critico' | 'atencao' | 'info';

export interface DirectorAlert {
  branchId: string;
  branchName: string;
  severity: AlertSeverity;
  title: string;
  causa: string;
  previsao: string;
  recomendacao: string;
}

export type CounterStatus = 'available' | 'serving' | 'paused';

export interface Counter {
  id: string;
  label: string;
  status: CounterStatus;
  currentTicketId: string | null;
  agentName: string | null;
  services: string[] | null; // null/vazio = atende todos os serviços (omissão)
}

export interface StaffMember {
  id: string;
  name: string;
  role: StaffRole;
  counterId: string | null; // balcão atribuído pelo gestor, ou nenhum
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

// Notas por aspeto específico do atendimento, 1-5 — chaves fixas
// partilhadas com o RatingScreen da app do cliente.
export interface RatingAspects {
  atendimento: number;
  tempoEspera: number;
  organizacao: number;
  instalacoes: number;
}

// Avaliação do cliente depois de concluído o atendimento (RatingScreen) —
// um documento por senha (id = ticketId), nunca alterável depois de
// criado.
export interface Rating {
  id: string;
  customerUid: string;
  serviceName: string;
  overall: number; // 1-5
  recommend: boolean;
  comment: string;
  aspects: RatingAspects;
  createdAt: number; // epoch ms
}
