// Motor de notificações (Fase 11/14/19 do hardening) -- confirma ao
// nível da base de dados que `record_notification_attempt` garante
// idempotência mesmo sob concorrência real (duas chamadas simultâneas
// para o mesmo event_id nunca criam duas linhas), e que
// `update_notification_status` grava o estado real de entrega. Não
// depende de nenhuma credencial Twilio -- testa só a camada Postgres
// que o motor usa (`supabase/functions/_shared/notifications/engine.ts`
// chama exactamente estas duas funções).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL as URL, SUPABASE_SERVICE_ROLE_KEY as SERVICE_ROLE_KEY } from './lib/test-env.mjs';

const svc = createClient(URL, SERVICE_ROLE_KEY);

let failures = 0;
const ok = (l) => console.log(`  OK  ${l}`);
const fail = (l, e) => { failures++; console.log(`  FALHOU  ${l} -- ${e ?? ''}`); };

async function recordAttempt(eventId) {
  const { data, error } = await svc.rpc('record_notification_attempt', {
    p_event_id: eventId, p_user_id: null, p_channel: 'whatsapp', p_provider: 'meta', p_priority: 'high',
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function main() {
  console.log('\n1. duas chamadas sequenciais para o mesmo event_id -- só a primeira insere');
  const eventId1 = `teste-notif-seq-${Date.now()}`;
  const first = await recordAttempt(eventId1);
  const second = await recordAttempt(eventId1);
  if (first.inserted === true && second.inserted === false && first.id === second.id) {
    ok('2ª chamada devolveu inserted=false com o mesmo id -- sem duplicar');
  } else {
    fail('idempotência sequencial falhou', JSON.stringify({ first, second }));
  }

  console.log('\n2. duas chamadas CONCORRENTES para o mesmo event_id -- nunca duas linhas (condição de corrida)');
  const eventId2 = `teste-notif-concorrente-${Date.now()}`;
  const [a, b] = await Promise.all([recordAttempt(eventId2), recordAttempt(eventId2)]);
  const insertedCount = [a, b].filter((r) => r.inserted).length;
  const { data: rows, error: countError } = await svc.from('notification_deliveries').select('id').eq('event_id', eventId2);
  if (countError) throw countError;
  if (insertedCount === 1 && rows.length === 1) {
    ok('exactamente 1 linha criada apesar das 2 chamadas concorrentes');
  } else {
    fail('condição de corrida NÃO fechada -- múltiplas linhas para o mesmo evento', JSON.stringify({ insertedCount, rows }));
  }

  console.log('\n3. update_notification_status grava estado real (sent -> delivered) e nunca inventa timestamps antecipados');
  const eventId3 = `teste-notif-estado-${Date.now()}`;
  const row = await recordAttempt(eventId3);
  const { error: updateSentError } = await svc.rpc('update_notification_status', {
    p_id: row.id, p_status: 'sent', p_provider_message_id: 'SM-teste-123',
  });
  if (updateSentError) throw updateSentError;
  const { data: afterSent } = await svc.from('notification_deliveries').select('*').eq('id', row.id).single();
  if (afterSent.status === 'sent' && afterSent.sent_at !== null && afterSent.delivered_at === null) {
    ok('estado "sent" gravado com sent_at preenchido e delivered_at ainda vazio');
  } else {
    fail('estado após "sent" incorrecto', JSON.stringify(afterSent));
  }

  const { error: updateDeliveredError } = await svc.rpc('update_notification_status', { p_id: row.id, p_status: 'delivered' });
  if (updateDeliveredError) throw updateDeliveredError;
  const { data: afterDelivered } = await svc.from('notification_deliveries').select('*').eq('id', row.id).single();
  if (afterDelivered.status === 'delivered' && afterDelivered.delivered_at !== null) {
    ok('estado "delivered" gravado com delivered_at preenchido');
  } else {
    fail('estado após "delivered" incorrecto', JSON.stringify(afterDelivered));
  }

  console.log('\n4. falha incrementa retry_count e grava error_code/error_message');
  const eventId4 = `teste-notif-falha-${Date.now()}`;
  const failRow = await recordAttempt(eventId4);
  await svc.rpc('update_notification_status', { p_id: failRow.id, p_status: 'failed', p_error_code: '21211', p_error_message: 'número inválido (teste)' });
  await svc.rpc('update_notification_status', { p_id: failRow.id, p_status: 'failed', p_error_code: '21211', p_error_message: 'número inválido (teste, retry)' });
  const { data: afterFail } = await svc.from('notification_deliveries').select('*').eq('id', failRow.id).single();
  if (afterFail.status === 'failed' && afterFail.retry_count === 2 && afterFail.error_code === '21211') {
    ok('2 falhas seguidas -- retry_count=2, error_code gravado');
  } else {
    fail('contagem de retries/estado de falha incorrecto', JSON.stringify(afterFail));
  }

  // limpeza
  await svc.from('notification_deliveries').delete().in('event_id', [eventId1, eventId2, eventId3, eventId4]);

  console.log(failures === 0 ? '\nTUDO OK -- motor de notificações idempotente e com estado real.\n' : `\n${failures} verificação(ões) falharam.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('ERRO inesperado:', err); process.exit(1); });
