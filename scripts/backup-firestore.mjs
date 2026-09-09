// Fase 0 do plano de migração (docs/migration-plan.md): exporta todo o
// conteúdo relevante do Firestore para um ficheiro JSON local antes de
// qualquer decisão de migração de dados -- mesmo quando a decisão for
// não migrar (ver Fase 11), fica um registo do estado em que o Firestore
// ficou no momento do corte para o Supabase.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const sa = JSON.parse(
  readFileSync('C:/Users/Paulino Quicassa/Desktop/filacerta-d74f0-firebase-adminsdk-fbsvc-88be935777.json', 'utf8'),
);
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const auth = getAuth();

async function dumpCollection(ref) {
  const snap = await ref.get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

async function dumpBranch(institutionId, branchRef) {
  const branchId = branchRef.id;
  return {
    id: branchId,
    data: (await branchRef.get()).data(),
    tickets: await dumpCollection(branchRef.collection('tickets')),
    appointments: await dumpCollection(branchRef.collection('appointments')),
    ratings: await dumpCollection(branchRef.collection('ratings')),
    counters: await dumpCollection(branchRef.collection('counters')),
    liveBoard: await dumpCollection(branchRef.collection('liveBoard')),
    meta: await dumpCollection(branchRef.collection('meta')),
  };
}

async function main() {
  const backup = { exportedAt: new Date().toISOString(), institutions: [], staff: [], users: [], authUsers: [] };

  const institutionsSnap = await db.collection('institutions').get();
  for (const instDoc of institutionsSnap.docs) {
    const branchesSnap = await instDoc.ref.collection('branches').get();
    const branches = [];
    for (const branchDoc of branchesSnap.docs) {
      branches.push(await dumpBranch(instDoc.id, branchDoc.ref));
    }
    backup.institutions.push({ id: instDoc.id, data: instDoc.data(), branches });
  }

  backup.staff = await dumpCollection(db.collection('staff'));

  // listDocuments() (não .get()) -- users/{uid} normalmente só existe
  // implicitamente (nunca é escrito com campos próprios, só tem
  // subcolecções), e um QuerySnapshot de .get() não devolve documentos
  // implícitos, só os que têm dados próprios.
  const userRefs = await db.collection('users').listDocuments();
  for (const userRef of userRefs) {
    const ownSnap = await userRef.get();
    backup.users.push({
      id: userRef.id,
      data: ownSnap.exists ? ownSnap.data() : null,
      appointments: await dumpCollection(userRef.collection('appointments')),
      history: await dumpCollection(userRef.collection('history')),
      notifications: await dumpCollection(userRef.collection('notifications')),
      settings: await dumpCollection(userRef.collection('settings')),
    });
  }

  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    backup.authUsers.push(
      ...page.users.map((u) => ({ uid: u.uid, email: u.email, disabled: u.disabled, providers: u.providerData.map((p) => p.providerId) })),
    );
    pageToken = page.pageToken;
  } while (pageToken);

  const dir = join(os.homedir(), 'Desktop', 'fila-certa-backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `firestore-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');

  console.log(`Backup escrito em: ${file}`);
  console.log(`instituições=${backup.institutions.length} staff=${backup.staff.length} users=${backup.users.length} authUsers=${backup.authUsers.length}`);
}

main().catch((err) => {
  console.error('ERRO no backup:', err);
  process.exit(1);
});
