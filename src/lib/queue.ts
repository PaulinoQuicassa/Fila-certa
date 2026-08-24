import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Counter, LiveBoard, Ticket } from '../types';

function branchPath(institutionId: string, branchId: string) {
  return `institutions/${institutionId}/branches/${branchId}`;
}

function toMillis(value: Timestamp | null | undefined): number | null {
  return value ? value.toMillis() : null;
}

function ticketFromDoc(id: string, data: Record<string, unknown>): Ticket {
  return {
    id,
    code: data.code as string,
    service: data.service as string,
    priority: Boolean(data.priority),
    status: data.status as Ticket['status'],
    counterId: (data.counterId as string | null) ?? null,
    createdAt: toMillis(data.createdAt as Timestamp) ?? Date.now(),
    calledAt: toMillis(data.calledAt as Timestamp),
    doneAt: toMillis(data.doneAt as Timestamp),
    transferredToCounterId: (data.transferredToCounterId as string | null) ?? null,
  };
}

/** Fila de espera ordenada por criação — filtro simples (sem orderBy no
 * servidor) para não exigir um índice composto no Firestore. */
export function subscribeWaitingQueue(
  institutionId: string,
  branchId: string,
  onChange: (tickets: Ticket[]) => void,
) {
  const ticketsRef = collection(db, `${branchPath(institutionId, branchId)}/tickets`);
  const q = query(ticketsRef, where('status', '==', 'waiting'));
  return onSnapshot(q, (snap) => {
    const tickets = snap.docs.map((d) => ticketFromDoc(d.id, d.data()));
    tickets.sort((a, b) => a.createdAt - b.createdAt);
    onChange(tickets);
  });
}

export function subscribeTicket(
  institutionId: string,
  branchId: string,
  ticketId: string,
  onChange: (ticket: Ticket | null) => void,
) {
  const ref = doc(db, `${branchPath(institutionId, branchId)}/tickets/${ticketId}`);
  return onSnapshot(ref, (snap) => {
    onChange(snap.exists() ? ticketFromDoc(snap.id, snap.data()) : null);
  });
}

export function subscribeCounter(
  institutionId: string,
  branchId: string,
  counterId: string,
  onChange: (counter: Counter | null) => void,
) {
  const ref = doc(db, `${branchPath(institutionId, branchId)}/counters/${counterId}`);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) return onChange(null);
    const data = snap.data();
    onChange({
      id: snap.id,
      label: data.label,
      status: data.status,
      currentTicketId: data.currentTicketId ?? null,
      agentName: data.agentName ?? null,
    });
  });
}

export function subscribeCounters(
  institutionId: string,
  branchId: string,
  onChange: (counters: Counter[]) => void,
) {
  const ref = collection(db, `${branchPath(institutionId, branchId)}/counters`);
  return onSnapshot(ref, (snap) => {
    const counters = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        label: data.label,
        status: data.status,
        currentTicketId: data.currentTicketId ?? null,
        agentName: data.agentName ?? null,
      } as Counter;
    });
    counters.sort((a, b) => a.label.localeCompare(b.label));
    onChange(counters);
  });
}

export function subscribeLiveBoard(
  institutionId: string,
  branchId: string,
  onChange: (board: LiveBoard) => void,
) {
  const ref = doc(db, `${branchPath(institutionId, branchId)}/liveBoard/current`);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      return onChange({ current: null, history: [], updatedAt: null });
    }
    const data = snap.data();
    onChange({
      current: data.current ?? null,
      history: data.history ?? [],
      updatedAt: toMillis(data.updatedAt as Timestamp),
    });
  });
}

/** Todas as senhas criadas hoje — para o dashboard calcular métricas no
 * cliente (volume baixo esperado num piloto; evita agregações no servidor). */
export function subscribeTicketsToday(
  institutionId: string,
  branchId: string,
  onChange: (tickets: Ticket[]) => void,
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const ticketsRef = collection(db, `${branchPath(institutionId, branchId)}/tickets`);
  const q = query(ticketsRef, where('createdAt', '>=', Timestamp.fromDate(startOfDay)));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => ticketFromDoc(d.id, d.data())));
  });
}

/** Lê o estado actual do painel ao vivo (tem de acontecer antes de
 * qualquer escrita na transacção — o Firestore exige todas as leituras
 * antes de todas as escritas). Devolve uma função que aplica a escrita. */
async function readLiveBoard(
  transaction: import('firebase/firestore').Transaction,
  institutionId: string,
  branchId: string,
) {
  const boardRef = doc(db, `${branchPath(institutionId, branchId)}/liveBoard/current`);
  const boardSnap = await transaction.get(boardRef);
  const prevCurrent = boardSnap.exists() ? boardSnap.data().current : null;
  const prevHistory = boardSnap.exists() ? (boardSnap.data().history ?? []) : [];
  return (entry: { code: string; counterLabel: string }) => {
    const nextHistory = prevCurrent ? [prevCurrent, ...prevHistory].slice(0, 4) : prevHistory;
    transaction.set(boardRef, {
      current: entry,
      history: nextHistory,
      updatedAt: serverTimestamp(),
    });
  };
}

/** Chama a próxima senha em espera para o balcão do agente. */
export async function callNext(
  institutionId: string,
  branchId: string,
  counterId: string,
  counterLabel: string,
  agentName: string,
  nextTicket: Ticket,
) {
  const ticketRef = doc(db, `${branchPath(institutionId, branchId)}/tickets/${nextTicket.id}`);
  const counterRef = doc(db, `${branchPath(institutionId, branchId)}/counters/${counterId}`);

  await runTransaction(db, async (transaction) => {
    const writeLiveBoard = await readLiveBoard(transaction, institutionId, branchId);
    transaction.update(ticketRef, {
      status: 'serving',
      counterId,
      calledAt: serverTimestamp(),
      transferredToCounterId: null,
    });
    transaction.update(counterRef, {
      status: 'serving',
      currentTicketId: nextTicket.id,
      agentName,
    });
    writeLiveBoard({ code: nextTicket.code, counterLabel });
  });
}

/** Repete a chamada da senha actual (sem mudar estado, só o painel público). */
export async function recallCurrent(
  institutionId: string,
  branchId: string,
  counterLabel: string,
  ticket: Ticket,
) {
  await runTransaction(db, async (transaction) => {
    const writeLiveBoard = await readLiveBoard(transaction, institutionId, branchId);
    writeLiveBoard({ code: ticket.code, counterLabel });
  });
}

async function clearCounter(
  institutionId: string,
  branchId: string,
  counterId: string,
) {
  const counterRef = doc(db, `${branchPath(institutionId, branchId)}/counters/${counterId}`);
  await runTransaction(db, async (transaction) => {
    transaction.update(counterRef, {
      status: 'available',
      currentTicketId: null,
      agentName: null,
    });
  });
}

export async function completeCurrent(
  institutionId: string,
  branchId: string,
  counterId: string,
  ticketId: string,
) {
  const ticketRef = doc(db, `${branchPath(institutionId, branchId)}/tickets/${ticketId}`);
  await runTransaction(db, async (transaction) => {
    transaction.update(ticketRef, { status: 'done', doneAt: serverTimestamp() });
  });
  await clearCounter(institutionId, branchId, counterId);
}

export async function markNoShow(
  institutionId: string,
  branchId: string,
  counterId: string,
  ticketId: string,
) {
  const ticketRef = doc(db, `${branchPath(institutionId, branchId)}/tickets/${ticketId}`);
  await runTransaction(db, async (transaction) => {
    transaction.update(ticketRef, { status: 'no_show', doneAt: serverTimestamp() });
  });
  await clearCounter(institutionId, branchId, counterId);
}

/** Devolve a senha à fila de espera e liberta o balcão actual. Se
 * `targetCounterId` for indicado, a senha fica reservada para esse balcão
 * (só ele a pode chamar); caso contrário volta à fila geral. */
export async function transferTicket(
  institutionId: string,
  branchId: string,
  counterId: string,
  ticketId: string,
  targetCounterId: string | null,
) {
  const ticketRef = doc(db, `${branchPath(institutionId, branchId)}/tickets/${ticketId}`);
  await runTransaction(db, async (transaction) => {
    transaction.update(ticketRef, {
      status: 'waiting',
      counterId: null,
      calledAt: null,
      transferredToCounterId: targetCounterId,
    });
  });
  await clearCounter(institutionId, branchId, counterId);
}

export async function setCounterPaused(
  institutionId: string,
  branchId: string,
  counterId: string,
  paused: boolean,
) {
  const counterRef = doc(db, `${branchPath(institutionId, branchId)}/counters/${counterId}`);
  await runTransaction(db, async (transaction) => {
    transaction.update(counterRef, { status: paused ? 'paused' : 'available' });
  });
}
