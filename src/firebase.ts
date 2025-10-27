import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCwC1_r80xt-PMnFv8_IofDdu1SEEAqVAI",
  authDomain: "mindi-kot.firebaseapp.com",
  projectId: "mindi-kot",
  storageBucket: "mindi-kot.firebasestorage.app",
  messagingSenderId: "707162495897",
  appId: "1:707162495897:web:462827fcde4a8937f2d108",
  measurementId: "G-5BRMQTTD4N"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

export async function ensureAnon() {
  if (!auth.currentUser) await signInAnonymously(auth);
}
