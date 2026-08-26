// Activa as restantes 5 localizações do MockData da app do cliente
// (hoje só "Banco Exemplo" é real) como instituições piloto reais no
// Firebase de PRODUÇÃO — mesma estrutura que scripts/seed-prod.mjs já
// usa para o Banco Exemplo (balcões + 1 gestor + 1 agente por
// instituição), sem senhas de exemplo pré-criadas.
//
// Correr:
//   GOOGLE_APPLICATION_CREDENTIALS="C:\caminho\para\a-chave.json" node scripts/seed-prod-extra-institutions.mjs
//
// Idempotente: correr outra vez não duplica nada (staff por email,
// balcões por id fixo).
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    'GOOGLE_APPLICATION_CREDENTIALS não está definido.\n' +
    '  GOOGLE_APPLICATION_CREDENTIALS="C:\\caminho\\para\\a-chave.json" node scripts/seed-prod-extra-institutions.mjs'
  );
  process.exit(1);
}

const app = initializeApp({ credential: applicationDefault(), projectId: 'filacerta-d74f0' });
const db = getFirestore(app);
const auth = getAuth(app);

// institutionId/branchId têm de bater certo com o que
// projectogestaodefilas/lib/data/mock_data.dart vai passar a usar.
const INSTITUTIONS = [
  {
    id: 'bpc',
    name: 'Banco de Poupança e Crédito (BPC)',
    branchId: 'agencia-talatona',
    branchName: 'Agência Talatona',
    agentName: 'Manuel Sacramento',
    managerName: 'Isabel Ferraz',
  },
  {
    id: 'bfa',
    name: 'Banco BFA',
    branchId: 'agencia-belas',
    branchName: 'Agência Belas',
    agentName: 'Domingos Neto',
    managerName: 'Ana Kiala',
  },
  {
    id: 'bai',
    name: 'Banco BAI',
    branchId: 'agencia-viana',
    branchName: 'Agência Viana',
    agentName: 'Fernando Bumba',
    managerName: 'Rosa Ferreira',
  },
  {
    id: 'bci',
    name: 'Banco BCI',
    branchId: 'agencia-kilamba',
    branchName: 'Agência Kilamba',
    agentName: 'Miguel Sumbo',
    managerName: 'Teresa Vieira',
  },
  {
    id: 'siac',
    name: 'SIAC — Serviço Integrado de Atendimento ao Cidadão',
    branchId: 'balcao-talatona',
    branchName: 'Balcão Talatona',
    agentName: 'Kiluanje Mateus',
    managerName: 'Fátima Chissano',
  },
];

async function upsertStaffUser({ email, password, name, role, institutionId, branchId, counterId }) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, password, displayName: name });
  }
  await db.doc(`staff/${user.uid}`).set({
    name,
    role,
    institutionId,
    branchId,
    ...(counterId ? { counterId } : {}),
  });
  console.log(`  staff: ${email} / ${password} (${role}${counterId ? `, ${counterId}` : ''})`);
}

async function seedInstitution(inst) {
  console.log(`\n${inst.name} (${inst.id})`);
  await db.doc(`institutions/${inst.id}`).set({ name: inst.name });
  await db.doc(`institutions/${inst.id}/branches/${inst.branchId}`).set({ name: inst.branchName });

  const counters = [
    { id: 'guiche-1', label: 'Balcão 1' },
    { id: 'guiche-2', label: 'Balcão 2' },
    { id: 'guiche-3', label: 'Balcão 3' },
  ];
  for (const c of counters) {
    await db.doc(`institutions/${inst.id}/branches/${inst.branchId}/counters/${c.id}`).set({
      label: c.label,
      status: 'available',
      currentTicketId: null,
      agentName: null,
    });
  }

  await upsertStaffUser({
    email: `agente@${inst.id}.test`,
    password: 'teste123',
    name: inst.agentName,
    role: 'agent',
    institutionId: inst.id,
    branchId: inst.branchId,
    counterId: 'guiche-1',
  });
  await upsertStaffUser({
    email: `gestor@${inst.id}.test`,
    password: 'teste123',
    name: inst.managerName,
    role: 'manager',
    institutionId: inst.id,
    branchId: inst.branchId,
  });
}

async function main() {
  for (const inst of INSTITUTIONS) {
    await seedInstitution(inst);
  }
  console.log('\nTodas as instituições activadas em PRODUÇÃO (filacerta-d74f0).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
