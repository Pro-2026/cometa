import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "AIzaSyBl_Mbb2fzOFtyUF5dpHm0otWFS45y_8TI",
  authDomain:        "cometa-8a3a5.firebaseapp.com",
  projectId:         "cometa-8a3a5",
  storageBucket:     "cometa-8a3a5.firebasestorage.app",
  messagingSenderId: "363557164860",
  appId:             "1:363557164860:web:0df2d597826214aaa3f039",
  measurementId:     "G-ESZQD7T1K4"
};

const _app = initializeApp(firebaseConfig);
export const auth = getAuth(_app);
export const db   = getFirestore(_app);
