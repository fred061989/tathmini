// Sign-in page: emails the admin a sign-in link (Supabase Auth).
(async () => {
  const cfg = await fetch('/api/config').then(r => r.json());
  const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  if (data.session) location.replace('/app.html');
  document.getElementById('signin').addEventListener('submit', async e => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    const msg = document.getElementById('msg');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + '/app.html' } });
    msg.className = error ? 'notice error' : 'notice';
    msg.textContent = error ? error.message : `Check ${email} for your sign-in link.`;
  });
})();
