import { supabase } from '../supabase';
import type {
  Appointment,
  Counter,
  DirectorAlert,
  DirectorBenchmarkRow,
  DirectorKpis,
  DirectorPeriod,
  DirectorTrendPoint,
  LiveBoard,
  Rating,
  StaffMember,
  Ticket,
} from '../types';

function toMillis(value: string | null | undefined): number | null {
  return value ? new Date(value).getTime() : null;
}

type TicketRow = {
  id: string;
  code: string;
  service: string;
  priority: boolean;
  status: Ticket['status'];
  counter_id: string | null;
  created_at: string;
  called_at: string | null;
  done_at: string | null;
  transferred_to_counter_id: string | null;
  no_show_reason: Ticket['noShowReason'];
  was_transferred: boolean;
  customer_on_the_way: boolean;
  customer_arrived_at: string | null;
  customer_delay_reported_at: string | null;
};

function ticketFromRow(row: TicketRow): Ticket {
  return {
    id: row.id,
    code: row.code,
    service: row.service,
    priority: row.priority,
    status: row.status,
    counterId: row.counter_id,
    createdAt: toMillis(row.created_at) ?? Date.now(),
    calledAt: toMillis(row.called_at),
    doneAt: toMillis(row.done_at),
    transferredToCounterId: row.transferred_to_counter_id,
    noShowReason: row.no_show_reason,
    wasTransferred: row.was_transferred,
    customerOnTheWay: row.customer_on_the_way,
    customerArrivedAt: toMillis(row.customer_arrived_at),
    customerDelayReportedAt: toMillis(row.customer_delay_reported_at),
  };
}

const TICKET_COLUMNS =
  'id, code, service, priority, status, counter_id, created_at, called_at, done_at, transferred_to_counter_id, no_show_reason, was_transferred, customer_on_the_way, customer_arrived_at, customer_delay_reported_at';

/** Assina mudanças numa tabela filtrada por `branch_id` e chama `refetch`
 * sempre que algo muda -- o filtro do canal só decide QUANDO voltar a ler,
 * a query de `refetch` é sempre a fonte da verdade (sempre filtrada por
 * institution_id + branch_id), por isso é seguro mesmo que dois IDs de
 * branch coincidam entre instituições diferentes.
 *
 * `refetch` corre também sempre que o canal fica `SUBSCRIBED` -- não só
 * na primeira vez, mas também depois de uma reconexão automática (perda
 * de rede, etc.). O Postgres Changes não reenvia eventos perdidos
 * enquanto o socket esteve em baixo, por isso sem isto o ecrã ficaria
 * preso no último estado visto antes de cair a ligação; assim, ao
 * reconectar, o estado é sempre resincronizado a partir da base de dados
 * (nunca se assume que os eventos perdidos "chegam depois"). */
function watchTable(table: string, branchId: string, refetch: () => void) {
  const channel = supabase
    .channel(`${table}:${branchId}:${Math.random().toString(36).slice(2)}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `branch_id=eq.${branchId}` },
      refetch,
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') refetch();
    });
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Fila de espera ordenada por criação. */
export function subscribeWaitingQueue(
  institutionId: string,
  branchId: string,
  onChange: (tickets: Ticket[]) => void,
) {
  async function refetch() {
    const { data } = await supabase
      .from('tickets')
      .select(TICKET_COLUMNS)
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true });
    onChange((data ?? []).map(ticketFromRow));
  }
  return watchTable('tickets', branchId, refetch);
}

export function subscribeTicket(
  institutionId: string,
  branchId: string,
  ticketId: string,
  onChange: (ticket: Ticket | null) => void,
) {
  async function refetch() {
    const { data } = await supabase
      .from('tickets')
      .select(TICKET_COLUMNS)
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .eq('id', ticketId)
      .maybeSingle();
    onChange(data ? ticketFromRow(data) : null);
  }
  const channel = supabase
    .channel(`ticket:${ticketId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `id=eq.${ticketId}` }, refetch)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') refetch();
    });
  return () => {
    void supabase.removeChannel(channel);
  };
}

type CounterRow = {
  id: string;
  label: string;
  status: Counter['status'];
  current_ticket_id: string | null;
  current_agent_name: string | null;
  services: string[] | null;
};

const COUNTER_COLUMNS = 'id, label, status, current_ticket_id, current_agent_name, services';

export function subscribeCounter(
  institutionId: string,
  branchId: string,
  counterId: string,
  onChange: (counter: Counter | null) => void,
) {
  async function refetch() {
    const { data } = await supabase
      .from('counters_with_agent')
      .select(COUNTER_COLUMNS)
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .eq('id', counterId)
      .maybeSingle();
    onChange(data ? counterFromRow(data) : null);
  }
  return watchTable('counters', branchId, refetch);
}

function counterFromRow(row: CounterRow): Counter {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    currentTicketId: row.current_ticket_id,
    agentName: row.current_agent_name,
    services: row.services,
  };
}

export function subscribeCounters(
  institutionId: string,
  branchId: string,
  onChange: (counters: Counter[]) => void,
) {
  async function refetch() {
    const { data } = await supabase
      .from('counters_with_agent')
      .select(COUNTER_COLUMNS)
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .order('label', { ascending: true });
    onChange((data ?? []).map(counterFromRow));
  }
  return watchTable('counters', branchId, refetch);
}

export function subscribeLiveBoard(
  institutionId: string,
  branchId: string,
  onChange: (board: LiveBoard) => void,
) {
  async function refetch() {
    const { data } = await supabase
      .from('ticket_calls')
      .select('code, counter_label, called_at')
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .order('called_at', { ascending: false })
      .limit(5);
    const rows = data ?? [];
    if (rows.length === 0) {
      onChange({ current: null, history: [], updatedAt: null });
      return;
    }
    const [current, ...history] = rows;
    onChange({
      current: { code: current.code, counterLabel: current.counter_label },
      history: history.map((h) => ({ code: h.code, counterLabel: h.counter_label })),
      updatedAt: toMillis(current.called_at),
    });
  }
  return watchTable('ticket_calls', branchId, refetch);
}

/** Todas as senhas criadas hoje -- para o dashboard calcular métricas no
 * cliente (volume baixo esperado num piloto; evita agregações no servidor). */
export function subscribeTicketsToday(
  institutionId: string,
  branchId: string,
  onChange: (tickets: Ticket[]) => void,
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  async function refetch() {
    const { data } = await supabase
      .from('tickets')
      .select(TICKET_COLUMNS)
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .gte('created_at', startOfDay.toISOString());
    onChange((data ?? []).map(ticketFromRow));
  }
  return watchTable('tickets', branchId, refetch);
}

type AppointmentRow = {
  id: string;
  customer_id: string;
  service: string;
  date: string;
  time: string;
  created_at: string;
  status: Appointment['status'];
};

function appointmentFromRow(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    customerUid: row.customer_id,
    serviceName: row.service,
    date: toMillis(row.date) ?? Date.now(),
    time: row.time,
    createdAt: toMillis(row.created_at) ?? Date.now(),
    status: row.status,
  };
}

/** Agendamentos marcados hoje para esta agência (tabela `appointments`
 * unificada -- ver docs/database-design.md). */
export function subscribeAppointmentsToday(
  institutionId: string,
  branchId: string,
  onChange: (appointments: Appointment[]) => void,
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  async function refetch() {
    const { data } = await supabase
      .from('appointments')
      .select('id, customer_id, service, date, time, created_at, status')
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .gte('created_at', startOfDay.toISOString());
    onChange((data ?? []).map(appointmentFromRow));
  }
  return watchTable('appointments', branchId, refetch);
}

type RatingRow = {
  id: string;
  customer_id: string;
  service: string;
  overall: number;
  recommend: boolean;
  comment: string;
  aspect_atendimento: number;
  aspect_tempo_espera: number;
  aspect_organizacao: number;
  aspect_instalacoes: number;
  created_at: string;
};

function ratingFromRow(row: RatingRow): Rating {
  return {
    id: row.id,
    customerUid: row.customer_id,
    serviceName: row.service,
    overall: row.overall,
    recommend: row.recommend,
    comment: row.comment,
    aspects: {
      atendimento: row.aspect_atendimento,
      tempoEspera: row.aspect_tempo_espera,
      organizacao: row.aspect_organizacao,
      instalacoes: row.aspect_instalacoes,
    },
    createdAt: toMillis(row.created_at) ?? Date.now(),
  };
}

/** Avaliações submetidas hoje pelos clientes, depois de concluído o
 * atendimento -- alimenta o resumo de qualidade do dashboard. */
export function subscribeRatingsToday(
  institutionId: string,
  branchId: string,
  onChange: (ratings: Rating[]) => void,
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  async function refetch() {
    const { data } = await supabase
      .from('ratings')
      .select(
        'id, customer_id, service, overall, recommend, comment, aspect_atendimento, aspect_tempo_espera, aspect_organizacao, aspect_instalacoes, created_at',
      )
      .eq('institution_id', institutionId)
      .eq('branch_id', branchId)
      .gte('created_at', startOfDay.toISOString());
    onChange((data ?? []).map(ratingFromRow));
  }
  return watchTable('ratings', branchId, refetch);
}

/** Tempo médio de espera hoje (minutos) -- agregado calculado no
 * servidor (`branch_wait_stats`), nunca linhas de `tickets` (o painel de
 * TV usa sessão anónima, que já não consegue ler `tickets` linha a
 * linha desde o hardening de segurança -- ver docs/security-rls.md).
 * Sem Realtime possível aqui (uma sessão anónima não recebe eventos de
 * mudança de senhas doutros clientes); em alternativa, reavaliado a
 * cada 30s -- suficiente para uma média, não para "à letra". */
export function subscribeBranchWaitStats(
  institutionId: string,
  branchId: string,
  onChange: (avgMinutes: number | null) => void,
) {
  let cancelled = false;
  async function refetch() {
    const { data } = await supabase.rpc('branch_wait_stats', {
      p_institution_id: institutionId,
      p_branch_id: branchId,
    });
    if (!cancelled) onChange(data === null || data === undefined ? null : Number(data));
  }
  refetch();
  const id = setInterval(refetch, 30_000);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Tira uma senha nova -- mesma RPC que a app do cliente usa
 * (`pull_ticket`, ver projectogestaodefilas/lib/ticket_service.dart).
 * Usada pela estação de auto-atendimento (`/estacao`) para quem chega
 * fisicamente ao balcão sem telemóvel/conta própria. O incremento
 * atómico e a escrita acontecem inteiramente no servidor (RLS bloqueia
 * INSERT directo em `tickets`). */
export async function pullTicket(institutionId: string, branchId: string, service: string): Promise<string> {
  const ticket = await rpc<{ code: string }>('pull_ticket', {
    p_institution_id: institutionId,
    p_branch_id: branchId,
    p_service: service,
  });
  return ticket.code;
}

/** Chama a próxima senha em espera para o balcão do agente -- a escolha
 * da senha (por prioridade/transferência/ordem de chegada) é feita no
 * servidor, com bloqueio (`SKIP LOCKED`) para nunca haver dois balcões a
 * chamar a mesma senha em simultâneo (ver call_next() em
 * supabase/migrations). */
export async function callNext(institutionId: string, branchId: string, counterId: string) {
  await rpc('call_next', { p_institution_id: institutionId, p_branch_id: branchId, p_counter_id: counterId });
}

/** Repete a chamada da senha actual (sem mudar estado, só o painel público). */
export async function recallCurrent(institutionId: string, branchId: string, counterId: string) {
  await rpc('recall_current', { p_institution_id: institutionId, p_branch_id: branchId, p_counter_id: counterId });
}

export async function completeCurrent(institutionId: string, branchId: string, counterId: string) {
  await rpc('complete_current', { p_institution_id: institutionId, p_branch_id: branchId, p_counter_id: counterId });
}

export async function markNoShow(institutionId: string, branchId: string, counterId: string) {
  await rpc('mark_no_show', { p_institution_id: institutionId, p_branch_id: branchId, p_counter_id: counterId });
}

/** Devolve a senha à fila de espera e liberta o balcão actual. Se
 * `targetCounterId` for indicado, a senha fica reservada para esse balcão
 * (só ele a pode chamar); caso contrário volta à fila geral. */
export async function transferTicket(
  institutionId: string,
  branchId: string,
  counterId: string,
  targetCounterId: string | null,
) {
  await rpc('transfer_ticket', {
    p_institution_id: institutionId,
    p_branch_id: branchId,
    p_counter_id: counterId,
    p_target_counter_id: targetCounterId,
  });
}

export async function setCounterPaused(institutionId: string, branchId: string, counterId: string, paused: boolean) {
  await rpc('set_counter_paused', {
    p_institution_id: institutionId,
    p_branch_id: branchId,
    p_counter_id: counterId,
    p_paused: paused,
  });
}

type StaffRow = { id: string; name: string; role: StaffMember['role']; counter_id: string | null };

/** Roster da filial (nome/papel/balcão atribuído) -- só para o gestor
 * configurar quem atende cada balcão (ecrã "Gerir Balcões" do Dashboard).
 * Sem Realtime (só muda por acção do próprio gestor -- refeito a seguir
 * a cada `assignCounterAgent`, ver ManageCounters.tsx). */
export async function listBranchStaff(institutionId: string, branchId: string): Promise<StaffMember[]> {
  const rows = await rpc<StaffRow[]>('list_branch_staff', { p_institution_id: institutionId, p_branch_id: branchId });
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, counterId: r.counter_id }));
}

/** Define os serviços atendidos por um balcão -- `services` vazio volta
 * a "todos os serviços" (comportamento actual, sem restrição). */
export async function setCounterServices(institutionId: string, branchId: string, counterId: string, services: string[]) {
  await rpc('set_counter_services', {
    p_institution_id: institutionId,
    p_branch_id: branchId,
    p_counter_id: counterId,
    p_services: services,
  });
}

/** Atribui (ou liberta, com `agentId: null`) o colaborador de um balcão
 * -- um balcão só tem um de cada vez, atribuir substitui quem lá estava. */
export async function assignCounterAgent(
  institutionId: string,
  branchId: string,
  counterId: string,
  agentId: string | null,
) {
  await rpc('assign_counter_agent', {
    p_institution_id: institutionId,
    p_branch_id: branchId,
    p_counter_id: counterId,
    p_agent_id: agentId,
  });
}

// --- Painel de Inteligência (Direcção Geral) ---------------------------------
// KPIs/tendência/benchmarking são cálculos reais (RPCs director_* no
// servidor); os alertas são regras simples sobre dados reais, não um
// motor de previsão -- ver comentário no topo da migração 20260910100100.

type DirectorKpisRow = {
  avg_wait_minutes: number | null; avg_wait_trend_pct: number | null;
  avg_satisfaction: number | null; avg_satisfaction_trend_pct: number | null;
  abandonment_pct: number | null; abandonment_trend_pct: number | null;
  completed_count: number; completed_trend_pct: number | null;
};

export async function fetchDirectorKpis(institutionId: string, period: DirectorPeriod): Promise<DirectorKpis> {
  const row = await rpc<DirectorKpisRow>('director_kpis', { p_institution_id: institutionId, p_period: period });
  return {
    avgWaitMinutes: row.avg_wait_minutes,
    avgWaitTrendPct: row.avg_wait_trend_pct,
    avgSatisfaction: row.avg_satisfaction,
    avgSatisfactionTrendPct: row.avg_satisfaction_trend_pct,
    abandonmentPct: row.abandonment_pct,
    abandonmentTrendPct: row.abandonment_trend_pct,
    completedCount: row.completed_count,
    completedTrendPct: row.completed_trend_pct,
  };
}

type DirectorTrendRow = { bucket_label: string; avg_wait_minutes: number | null };

export async function fetchDirectorTrend(institutionId: string, period: DirectorPeriod): Promise<DirectorTrendPoint[]> {
  const rows = await rpc<DirectorTrendRow[]>('director_trend', { p_institution_id: institutionId, p_period: period });
  return rows.map((r) => ({ label: r.bucket_label, avgWaitMinutes: r.avg_wait_minutes }));
}

type DirectorBenchmarkRowRaw = {
  branch_id: string; branch_name: string; avg_wait_minutes: number | null;
  avg_satisfaction: number | null; abandonment_pct: number; score: number;
};

export async function fetchDirectorBenchmarking(institutionId: string, period: DirectorPeriod): Promise<DirectorBenchmarkRow[]> {
  const rows = await rpc<DirectorBenchmarkRowRaw[]>('director_benchmarking', { p_institution_id: institutionId, p_period: period });
  return rows.map((r) => ({
    branchId: r.branch_id, branchName: r.branch_name, avgWaitMinutes: r.avg_wait_minutes,
    avgSatisfaction: r.avg_satisfaction, abandonmentPct: r.abandonment_pct, score: r.score,
  }));
}

type DirectorAlertRow = {
  branch_id: string; branch_name: string; severity: string; title: string;
  causa: string; previsao: string; recomendacao: string;
};

export async function fetchDirectorAlerts(institutionId: string, period: DirectorPeriod): Promise<DirectorAlert[]> {
  const rows = await rpc<DirectorAlertRow[]>('director_alerts', { p_institution_id: institutionId, p_period: period });
  return rows.map((r) => ({
    branchId: r.branch_id, branchName: r.branch_name, severity: r.severity as DirectorAlert['severity'],
    title: r.title, causa: r.causa, previsao: r.previsao, recomendacao: r.recomendacao,
  }));
}
