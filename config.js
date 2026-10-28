/*
 * config.js — the ONLY file you need to edit.
 *
 * 1. SUPABASE_URL : Supabase dashboard → Connect → Project URL
 * 2. SUPABASE_KEY : Supabase dashboard → Connect → publishable / anon key
 *
 * The publishable (anon) key is designed to be public: it is safe in a public
 * GitHub repo because Row Level Security + the SQL functions protect the data.
 *
 * NEVER put the "service_role" / "secret" key in this file or anywhere in the repo.
 */
window.NB_CONFIG = {
  SUPABASE_URL: 'https://pfavcwvhavsrzlgquhqg.supabase.co',   // <- check this matches your project
  SUPABASE_KEY: 'sb_publishable_KSrd5Ql1CTx_CDayKibN8A_wtnHbnNm',                   // <- paste your publishable / anon key

  // Autosave after this many ms of inactivity (0 = off, only Ctrl+S saves).
  AUTOSAVE_MS: 6000,

  // Rows per page on the master dashboard.
  PAGE_SIZE: 12,

  // How often (ms) an open notebook double-checks the server (deletions, missed live updates).
  POLL_MS: 30000
};