import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

// Mesmo projecto Firebase da app cliente Flutter (projectogestaodefilas /
// lib/firebase_options.dart) — a config web do Firebase não é secreta,
// o controlo de acesso vive nas Firestore Security Rules, não na chave.
const firebaseConfig = {
  apiKey: 'AIzaSyC7GYgxawqD5SzmEPdTzfKg4iKbaPyLcqA',
  authDomain: 'filacerta-d74f0.firebaseapp.com',
  projectId: 'filacerta-d74f0',
  storageBucket: 'filacerta-d74f0.firebasestorage.app',
  messagingSenderId: '786280071370',
  appId: '1:786280071370:web:ee14e7a798326ab6fe7433',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Em desenvolvimento, ligar aos emuladores locais em vez do Firebase de
// produção — nunca escrever dados de teste no projecto real.
if (import.meta.env.VITE_USE_EMULATOR === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
