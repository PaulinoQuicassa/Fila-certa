import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('C:/Users/Paulino Quicassa/Desktop/filacerta-d74f0-firebase-adminsdk-fbsvc-88be935777.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const institutions = await db.collection('institutions').listDocuments();
let totalTickets = 0, totalAppointments = 0, totalRatings = 0;
for (const inst of institutions) {
  const branches = await inst.collection('branches').listDocuments();
  for (const branch of branches) {
    const tickets = await branch.collection('tickets').count().get();
    const appts = await branch.collection('appointments').count().get();
    const ratings = await branch.collection('ratings').count().get();
    totalTickets += tickets.data().count;
    totalAppointments += appts.data().count;
    totalRatings += ratings.data().count;
    console.log(`${inst.id}/${branch.id}: tickets=${tickets.data().count} appointments=${appts.data().count} ratings=${ratings.data().count}`);
  }
}
console.log(`\nTOTAL: tickets=${totalTickets} appointments=${totalAppointments} ratings=${totalRatings}`);

const usersSnap = await db.collection('users').listDocuments();
console.log(`\nusers/: ${usersSnap.length} contas`);
let totalNotif = 0, totalPrivAppt = 0, totalHistory = 0;
for (const u of usersSnap) {
  const notif = await u.collection('notifications').count().get();
  const appt = await u.collection('appointments').count().get();
  const hist = await u.collection('history').count().get();
  totalNotif += notif.data().count;
  totalPrivAppt += appt.data().count;
  totalHistory += hist.data().count;
}
console.log(`notifications=${totalNotif} private-appointments=${totalPrivAppt} history=${totalHistory}`);
process.exit(0);
