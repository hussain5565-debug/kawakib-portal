import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Portal from './app/portal';
import { sb, watchIdle } from './lib/supabase';
import './app/globals.css';

function App() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => { setSignedIn(!!data.session); setReady(true); });
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => setSignedIn(!!session));
    watchIdle();
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!ready) return null;
  return <Portal signedIn={signedIn} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
