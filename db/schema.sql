-- Tathmini CBC (Phase 1): Supabase / Postgres schema.
-- Run in the Supabase SQL editor. The API uses the service-role key and enforces
-- school scoping itself; RLS is enabled with no policies so the anon key cannot read anything.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  short_name TEXT,
  county TEXT,
  address TEXT,                          -- printed on report forms
  phone TEXT,
  email TEXT,
  motto TEXT,
  head_teacher_name TEXT,
  logo TEXT,                             -- small image (data URL), printed on report forms
  grading JSONB NOT NULL DEFAULT '{}',   -- threshold overrides, e.g. {"cbc4":{"EE":75,"ME":50,"AE":25}}
  google_refresh_token TEXT,             -- the school's Google account (drive.file scope)
  google_email TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),  -- prepaid balance (KES × 100)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id UUID UNIQUE,                   -- auth.users.id, linked on an admin's first sign-in
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,                   -- teachers: the Google account their sheets are shared with
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),  -- only admins sign in
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, email)
);

CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  grade INTEGER NOT NULL CHECK (grade BETWEEN -1 AND 12),   -- PP1=-1, PP2=0
  stream TEXT,
  year INTEGER NOT NULL,
  class_teacher_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, grade, stream, year)
);

CREATE TABLE IF NOT EXISTS learners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  adm_no TEXT,
  assessment_no TEXT,                    -- KNEC assessment number
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('F', 'M')),
  parent_name TEXT,
  parent_phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, adm_no)
);

-- National curriculum, shared by every school and maintained by the platform owner.
CREATE TABLE IF NOT EXISTS learning_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  code TEXT,
  grades INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learning_area_id UUID NOT NULL REFERENCES learning_areas(id) ON DELETE CASCADE,
  grade INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sub_strands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strand_id UUID NOT NULL REFERENCES strands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teacher_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  learning_area_id UUID NOT NULL REFERENCES learning_areas(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class_id, learning_area_id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  assignment_id UUID REFERENCES teacher_assignments(id) ON DELETE SET NULL,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  learning_area_id UUID NOT NULL REFERENCES learning_areas(id) ON DELETE CASCADE,
  teacher_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opener', 'weekly', 'monthly', 'mid_term', 'end_term', 'custom')),
  per_strand BOOLEAN NOT NULL DEFAULT FALSE,
  term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 3),
  year INTEGER NOT NULL,
  week INTEGER,
  assessed_on DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sheet_ready', 'analysed')),
  sheet_id TEXT,
  sheet_url TEXT,
  summary JSONB,
  analysed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What is scored: one row per strand or sub-strand, or a single "Total" row.
CREATE TABLE IF NOT EXISTS assessment_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  strand_id UUID REFERENCES strands(id) ON DELETE SET NULL,
  sub_strand_id UUID REFERENCES sub_strands(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  max_score NUMERIC NOT NULL CHECK (max_score > 0),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scores (
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  component_id UUID NOT NULL REFERENCES assessment_components(id) ON DELETE CASCADE,
  raw_score TEXT,
  absent BOOLEAN NOT NULL DEFAULT FALSE,
  comment TEXT,                          -- the teacher's comment from the sheet
  PRIMARY KEY (assessment_id, learner_id, component_id)
);

CREATE TABLE IF NOT EXISTS results (
  assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('assessed', 'absent', 'missing')),
  percent NUMERIC,
  level TEXT,
  points INTEGER,
  change NUMERIC,
  strands JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (assessment_id, learner_id)
);

-- A school term: dates printed on report forms. Closing a term locks its results.
CREATE TABLE IF NOT EXISTS terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 3),
  closing_date DATE,
  next_term_date DATE,
  closed_at TIMESTAMPTZ,
  UNIQUE (school_id, year, term)
);

-- Class and head teacher comments for a learner's termly report (drafted, then edited by the admin).
CREATE TABLE IF NOT EXISTS report_comments (
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  term INTEGER NOT NULL,
  class_comment TEXT,
  head_comment TEXT,
  co_curricular TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, year, term)
);

-- Billing: each learner is paid for term by term, from a prepaid balance (amounts in cents).
-- KES 20 per term, or KES 50 for the year (all three terms).
CREATE TABLE IF NOT EXISTS learner_terms (
  learner_id UUID NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  term INTEGER NOT NULL CHECK (term BETWEEN 1 AND 3),
  plan TEXT NOT NULL CHECK (plan IN ('term', 'year')),
  fee_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, year, term)
);

CREATE TABLE IF NOT EXISTS account_ledger (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- increasing, so entries keep their exact order
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  change_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'learner_fee', 'refund', 'adjustment')),
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Takes money only if the balance covers it; returns the new balance, or NULL if it does not.
CREATE OR REPLACE FUNCTION consume_balance(p_school UUID, p_cents INTEGER) RETURNS INTEGER
LANGUAGE sql AS $$
  UPDATE schools SET balance_cents = balance_cents - p_cents
  WHERE id = p_school AND balance_cents >= p_cents
  RETURNING balance_cents;
$$;

-- Adds money (negative to correct); never goes below zero.
CREATE OR REPLACE FUNCTION add_balance(p_school UUID, p_cents INTEGER) RETURNS INTEGER
LANGUAGE sql AS $$
  UPDATE schools SET balance_cents = GREATEST(balance_cents + p_cents, 0)
  WHERE id = p_school
  RETURNING balance_cents;
$$;

CREATE INDEX IF NOT EXISTS idx_staff_school ON staff(school_id);
CREATE INDEX IF NOT EXISTS idx_staff_email ON staff(lower(email));
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);
CREATE INDEX IF NOT EXISTS idx_learners_class ON learners(class_id);
CREATE INDEX IF NOT EXISTS idx_strands_area ON strands(learning_area_id, grade);
CREATE INDEX IF NOT EXISTS idx_sub_strands_strand ON sub_strands(strand_id);
CREATE INDEX IF NOT EXISTS idx_assign_teacher ON teacher_assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_assess_school ON assessments(school_id, status);
CREATE INDEX IF NOT EXISTS idx_assess_class_term ON assessments(class_id, year, term);
CREATE INDEX IF NOT EXISTS idx_components_assess ON assessment_components(assessment_id);
CREATE INDEX IF NOT EXISTS idx_results_learner ON results(learner_id);
CREATE INDEX IF NOT EXISTS idx_learner_terms_school ON learner_terms(school_id, year, term);
CREATE INDEX IF NOT EXISTS idx_ledger_school ON account_ledger(school_id, created_at);

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE learners ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE strands ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_strands ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_ledger ENABLE ROW LEVEL SECURITY;
