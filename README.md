# Tathmini CBC

Assessment records and termly report forms for Kenyan CBC schools (Phase 1).

Only school **admins** sign in, e.g. the head teacher and the ICT person. **Teachers never sign in**: they receive a Google Sheet for each assessment by Gmail, fill in scores (and optionally a short comment per learner), and the school does the rest.

## How it works

1. **Setup (admin):** a *Getting started* checklist on the dashboard walks a new school through it:
   - school details and logo (printed on report forms);
   - classes with class teachers;
   - learners, uploaded from an Excel file or pasted, with a downloadable template;
   - teachers (name and Gmail), and who teaches which learning area in which class.

   Learning areas, strands and sub-strands come from the **national curriculum**. Learners and teachers can be edited, moved or removed (history is kept), and teachers who leave have their learning areas flagged for reassignment.
2. **New assessment:** pick the class and learning areas, the type (opener, weekly, monthly, mid-term, end-term or custom), the term, and whether to score it as a total, **per strand** or **per sub-strand**. Several learning areas can be created at once.
3. **Score sheets:** a Google Sheet per learning area is created in the school's Google account, with the class list filled in and locked, and shared with that subject's teacher by Gmail. Scores are validated against each strand's maximum; absent learners are marked Y.
4. **Check progress, then Analyse:** the admin sees "6/8 entered, 1 partly", then presses **Analyse**. Scores become CBC levels per learner and strand, with class means, strands to re-teach, learners needing support, and progress since the last assessment. Learners are not ranked.
   - A teacher who can't use Google Sheets can hand in marks on paper; the admin types them in with **Enter scores here**.
   - An assessment created by mistake can be deleted.
5. **Class results:** the class teacher's sheet for a term, with every learner's term average per learning area and the class means. It prints landscape or downloads as Excel.
6. **Report forms:** one A4 page per learner. They can be printed for one learner or the whole class, or **downloaded as a ZIP with one PDF per learner**, named after them.
   - It shows scores for each assessment type, the term average and CBC level per learning area, the subject teacher's comment and initials, and the overall average.
   - It also shows strongest areas, areas needing support, strands to work on, the class and head teacher's comments, signatures, the stamp, and term dates.
   - The class and head teacher's comments are **drafted from the results**, and the admin edits them before printing.
   - **Closing the term** locks its results and comments so printed reports stay final. Until then reports are marked *provisional*.

**Term averages:** within a term, each assessment type counts once (two monthly tests are averaged into one "Monthly" score), and the term average is the mean of the types. Absences are left out, not counted as zero. The overall average gives each learning area equal weight.

## Grading

| Grades | Rubric | Default thresholds |
|---|---|---|
| PP1–Grade 6 | 4-level | EE ≥80, ME ≥50, AE ≥30, BE below |
| Grade 7–9 | KNEC 8-level | EE1 ≥90, EE2 ≥75, ME1 ≥58, ME2 ≥41, AE1 ≥31, AE2 ≥21, BE1 ≥11, BE2 below |

Each school can change the thresholds under Settings.

7. **New year:** **Promote** moves a whole class to the next grade and year (e.g. Grade 7 East 2026 becomes Grade 8 East 2027). Old report forms still print. A final-year class can be marked as finished.
8. **Help:** a Help page explains every step in plain language.

## Pricing (Phase 1)

- Each learner is paid for from the school's prepaid balance: **KES 20 per term** (`LEARNER_TERM_FEE_KES`) or **KES 50 for the whole year** (`LEARNER_FEE_KES`).
- Adding learners costs nothing. Right after adding, the admin is asked to pay for the new learners by the term or the year, or later. Billing can also pay for all unpaid learners at once, showing both prices first.
- Paying for the year after some terms are already paid charges only the remaining terms, never more than KES 50 a year in total.
- Learners not paid for a term are left out of that term's sheets and report forms.
- Schools pay the platform owner directly (e.g. by M-Pesa). The owner records the payment on **All schools**, and it appears in the school's account activity.

## Platform owner

Set `PLATFORM_OWNER_EMAILS` to your sign-in email. You then get:
- **National curriculum:**
  - **Load starter curriculum** adds the CBC learning areas for PP1 to Grade 9, plus some Junior School strands. **Check these against the KICD curriculum designs.**
  - **Import** pasted spreadsheet rows (`grade, learning_area, code, strand, sub_strand`). **Check** validates without saving.
  - **Download as CSV**.
- **All schools:** balances, learners paid for this year, and recording payments.

## Setup

1. **Supabase:** create a project and run `db/schema.sql` in the SQL editor. Under Authentication → URL configuration, add `${APP_URL}/app.html` as a redirect URL.
2. **Google Cloud:**
   - Create an OAuth client of type "Web application".
   - Enable the Google Sheets API and the Google Drive API.
   - Add `${APP_URL}/api/google/callback` as an authorised redirect URI.
   - Scopes: `drive.file`, `openid`, `email`.
3. Copy `.env.example` to `.env` (or set the variables in Vercel) and fill it in.
4. Run it:
   ```
   npm install
   npm test
   npm run dev        # http://localhost:3000
   ```
5. Deploy with `vercel`. Node 22+ is required.

## Code

- `lib/cbc.js`: grading.
- `lib/analysis.js`: one assessment.
- `lib/term.js`: term averages, report forms, comment drafts.
- `lib/sheets.js`: Google Sheets.
- `lib/billing.js`: learner fees.
- `lib/routes/*`: the API.
- `public/`: the web app.
- `test/`: unit tests, plus an end-to-end test of the whole flow against an in-memory database.

## Security

- **Sign-in:** only admins sign in (Supabase email links). Every API route checks the sign-in and limits a school to its own records; tests check that another school's admin is refused.
- **Database:** the service key stays on the server, and RLS is on with no policies, so the public anon key can't read anything. The school's Google token is never sent to the browser.
- **Sheets:** teachers' sheets are written with `RAW` values, so a name or comment can't become a formula. Learner names and headers are locked.
- **Browser:**
  - Everything shown on screen is escaped.
  - Third-party libraries are **served from the app itself** (`public/vendor/`), not a CDN.
  - A strict Content-Security-Policy (scripts only from the app, no inline scripts, no framing) plus other security headers are set in `vercel.json`.
  - Logos must be PNG, JPEG or WEBP data, never SVG.
- **Input checks:** emails, grades, years, terms, dates and amounts are validated, and upload sizes are limited.
- **Secrets:** `STATE_SECRET` must be a long random value; the Google sign-in step is signed and expires after 15 minutes.

## Data protection

The app stores children's personal data, so it falls under Kenya's Data Protection Act 2019:
- Get parental consent.
- Limit admin accounts.
- Check whether you must register with the ODPC.
