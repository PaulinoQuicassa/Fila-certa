// Semeia dados de exemplo no emulador local do Firestore (nunca no
// projecto de produção — este script recusa-se a correr sem
// FIRESTORE_EMULATOR_HOST definido). Uso:
//   firebase emulators:start --only auth,firestore   (noutro terminal)
//   node scripts/seed.mjs
import admin from 'firebase-admin';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    'FIRESTORE_EMULATOR_HOST não está definido — este script só corre contra o emulador local.\n' +
    'Corre: firebase emulators:start --only auth,firestore  (noutro terminal) e depois:\n' +
    '  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/seed.mjs'
  );
  process.exit(1);
}

admin.initializeApp({ projectId: 'filacerta-d74f0' });
const db = admin.firestore();
const auth = admin.auth();

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
    { id: 'guiche-1', label: 'Guichê 1' },
    { id: 'guiche-2', label: 'Guichê 2' },
    { id: 'guiche-3', label: 'Guichê 3' },
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
        createdAt: admin.firestore.Timestamp.fromMillis(now - (6 - i) * 4 * 60000),
        calledAt: null,
        doneAt: null,
      });
    }
    console.log(`6 senhas de exemplo criadas em tickets/`);
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

  console.log('\nSeed concluído no emulador local.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
