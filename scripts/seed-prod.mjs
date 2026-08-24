// Semeia os MESMOS dados de exemplo do seed.mjs, mas no Firebase de
// PRODUÇÃO (filacerta-d74f0) em vez do emulador local.
//
// Porque isto não corre a partir da sessão do Claude Code: escrever em
// produção precisa de uma credencial de service account (não da sessão
// `firebase login` do CLI, que o Admin SDK não reaproveita), e gerar/usar
// essa credencial é uma acção com efeitos reais que o utilizador deve
// accionar ele próprio.
//
// Passos:
//   1. Firebase Console → Definições do projeto → Contas de serviço →
//      "Gerar nova chave privada" — descarrega um ficheiro .json.
//   2. Guardar esse ficheiro FORA do repositório (ex.: Desktop), nunca
//      commitar (já está coberto por *.json em .gitignore-service-account,
//      mas confirma antes de correr `git add`).
//   3. Correr:
//        GOOGLE_APPLICATION_CREDENTIALS="C:\caminho\para\a-chave.json" node scripts/seed-prod.mjs
//
// Idempotente: correr outra vez não duplica dados (staff por email,
// counters por id fixo; só cria as 6 senhas de exemplo se a colecção
// ainda estiver vazia).
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    'GOOGLE_APPLICATION_CREDENTIALS não está definido.\n' +
    'Gera uma chave de service account em Firebase Console → Definições do\n' +
    'projeto → Contas de serviço → Gerar nova chave privada, e corre:\n' +
    '  GOOGLE_APPLICATION_CREDENTIALS="C:\\caminho\\para\\a-chave.json" node scripts/seed-prod.mjs'
  );
  process.exit(1);
}

const app = initializeApp({
  credential: applicationDefault(),
  projectId: 'filacerta-d74f0',
});
const db = getFirestore(app);
const auth = getAuth(app);

const INSTITUTION_ID = 'banco-exemplo';
const BRANCH_ID = 'agencia-maianga';

async function upsertStaffUser({ email, password, name, role, counterId }) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, password, displayName: name });
  }
  await db.doc(`staff/${user.uid}`).set({
    name,
    role,
    institutionId: INSTITUTION_ID,
    branchId: BRANCH_ID,
    ...(counterId ? { counterId } : {}),
  });
  console.log(`staff: ${email} / ${password} (${role}${counterId ? `, ${counterId}` : ''})`);
}

async function main() {
  await db.doc(`institutions/${INSTITUTION_ID}`).set({ name: 'Banco Exemplo' });
  await db.doc(`institutions/${INSTITUTION_ID}/branches/${BRANCH_ID}`).set({ name: 'Agência Maianga' });

  const counters = [
    { id: 'guiche-1', label: 'Balcão 1' },
    { id: 'guiche-2', label: 'Balcão 2' },
    { id: 'guiche-3', label: 'Balcão 3' },
  ];
  for (const c of counters) {
    await db.doc(`institutions/${INSTITUTION_ID}/branches/${BRANCH_ID}/counters/${c.id}`).set({
      label: c.label,
      status: 'available',
      currentTicketId: null,
      agentName: null,
    });
  }

  const services = ['Abertura de conta', 'Cartão bancário', 'Empréstimo', 'Reclamação'];
  const ticketsRef = db.collection(`institutions/${INSTITUTION_ID}/branches/${BRANCH_ID}/tickets`);
  const existing = await ticketsRef.limit(1).get();
  if (existing.empty) {
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      const code = `A0${50 + i}`;
      await ticketsRef.doc().set({
        code,
        service: services[i % services.length],
        priority: i === 2,
        status: 'waiting',
        counterId: null,
        createdAt: Timestamp.fromMillis(now - (6 - i) * 4 * 60000),
        calledAt: null,
        doneAt: null,
      });
    }
    console.log('6 senhas de exemplo criadas em tickets/');
  }

  await upsertStaffUser({
    email: 'agente@filacerta.test',
    password: 'teste123',
    name: 'João Manuel',
    role: 'agent',
    counterId: 'guiche-3',
  });
  await upsertStaffUser({
    email: 'gestor@filacerta.test',
    password: 'teste123',
    name: 'Beatriz Neto',
    role: 'manager',
  });

  console.log('\nSeed de PRODUÇÃO concluído (filacerta-d74f0).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
