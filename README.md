# Colab-style notebooks with a master dashboard

Two static pages that talk to your Supabase project:

| File | What it is |
|---|---|
| `index.html` | The Colab-style notebook editor (what users see) |
| `master.html` | Mobile-friendly master dashboard: sign in, list every notebook, open one to edit |
| `config.js` | **The only file you edit** (Supabase URL + publishable key) |
| `notebook.js`, `master.js`, `common.js`, `nbcore.js` | Page logic |
| `base.css`, `colab.css`, `master.css` | Styles (light and dark themes, phone layouts) |

There is no build step. Push the files and turn on GitHub Pages.

---

## 1. Supabase (once)

You already ran the two SQL files. Also make sure:

1. **Authentication → Sign In / Providers → "Allow anonymous sign-ins" is ON.** Visitors to `index.html` get a guest identity this way.
2. **Authentication → Users → Add user** created your master account (email + password), and its UUID is in `public.master_users`:
   ```sql
   select * from public.master_users;   -- should return one row
   ```

## 2. Put your key in `config.js`

Open `config.js` and set:

```js
SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
SUPABASE_KEY: 'YOUR_PUBLISHABLE_KEY_HERE',
```

Both are in Supabase → **Connect** (the publishable / `anon` key).

The publishable key is meant to be public. It is safe in a public repo because Row Level Security and the SQL functions decide what each user can do.
**Never** put the `service_role` / secret key in any file.

## 3. Publish on GitHub Pages

1. Create a repository and upload the **extracted** files so `index.html` sits at the top level (not inside a folder).
2. Repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save.**
3. After a minute your pages are live:
   - Users: `https://YOUR-NAME.github.io/YOUR-REPO/`  (or `/index.html`)
   - Master: `https://YOUR-NAME.github.io/YOUR-REPO/master.html`

No Supabase URL allow-listing is needed for this setup.

## 4. How it works

**Users (`index.html`)**
- Opening the page creates a guest account in the background. Nothing is written to the database until the first save.
- Rename the notebook in the title box, then press **Ctrl+S** (or Save in the File menu). Saving never creates a duplicate: the notebook keeps one permanent ID.
- Autosave runs a few seconds after you stop typing. The status text shows *Unsaved changes → Saving… → All changes saved*, and it only says saved after the server confirms.
- If the connection drops, edits stay in the page (and a local draft) and are retried automatically.
- Reopening the page in the same browser brings back your latest notebook. (Guest accounts live in that browser's storage: clearing site data detaches them.)

**Master (`master.html`)**
- Sign in with the master email and password. Accounts that are not in `master_users` are refused.
- The list comes from the database (search, sort, pages, "Active" badge for notebooks saved in the last 2 minutes) and updates live when someone saves or renames.
- **Open** goes to `index.html?notebook_id=<uuid>&mode=master`. The URL parameter is only a *request*: master editing works only if your signed-in account is in `master_users`, and the database enforces it again on every read and write.
- Cells changed by the master show an *Edited by master* badge to the user.

**Editing at the same time**
- Every save carries the revision it started from. If someone else saved first, the page merges automatically when different cells changed.
- If the *same* cell changed in both places, autosave pauses and a banner lets you choose "Keep mine" or "Use latest saved" per cell. Nothing is silently overwritten.

## 5. Things to know

- **Run is a mock.** The ▶ button simulates `print()`, variables and simple arithmetic so the interface feels like Colab. Outputs are not saved. Real Python needs a separate sandboxed kernel (for example Pyodide in the browser) and is not included.
- **Limits** enforced by the database: 20 notebooks per user, 500 cells per notebook, 100,000 characters per cell.
- **Realtime** needs the last block of the step 4–6 SQL (it adds both tables to the `supabase_realtime` publication). Without it everything still works; pages just catch up every 30 seconds (`POLL_MS`) instead of instantly.
- Text cells are rendered with a small safe Markdown renderer: raw HTML is never executed, so a user cannot inject script into the master's session.
- `.ipynb` export is in **File → Download .ipynb**.
- Keyboard shortcuts are listed under **Tools → Keyboard shortcuts**.
- The sun/moon button in the top bar switches light and dark theme; the choice is remembered in the browser.

## 6. Troubleshooting

| You see | Do this |
|---|---|
| "Almost there — add your Supabase key" | Edit `config.js`, commit, reload |
| "Guest sign-in is turned off" | Enable anonymous sign-ins (step 1) |
| Master sign in says "not a master account" | Insert that user's UUID into `public.master_users` |
| "Notebook not found" | The ID is wrong, deleted, or the account has no access (the message is intentionally the same) |
| Changes show "Offline — will retry" | Connection issue; it retries by itself and keeps your text |
| Page blank on GitHub Pages | Files must be at the repo root; wait a minute after enabling Pages and hard-reload |
