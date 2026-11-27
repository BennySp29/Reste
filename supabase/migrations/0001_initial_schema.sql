-- Reste — Household Budget Planner Schema, RLS, RPCs & Realtime

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Private schema for SECURITY DEFINER helpers & auth triggers (never exposed via PostgREST)
CREATE SCHEMA IF NOT EXISTS private;

-- 1. Tables
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL DEFAULT '#1b6b5a',
    active_household_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.households (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL DEFAULT 'Our Household',
    invite_code TEXT NOT NULL UNIQUE,
    currency TEXT NOT NULL DEFAULT '£',
    active_month TEXT NOT NULL DEFAULT 'current',
    payday_day INTEGER NOT NULL DEFAULT 1 CHECK (payday_day >= 1 AND payday_day <= 31),
    partner_a_name TEXT NOT NULL DEFAULT 'Partner 1',
    partner_b_name TEXT NOT NULL DEFAULT 'Partner 2',
    split_mode TEXT NOT NULL DEFAULT 'custom' CHECK (split_mode IN ('custom', 'suggested', 'equal')),
    partner_a_split NUMERIC(6, 4) NOT NULL DEFAULT 0.5000 CHECK (partner_a_split >= 0 AND partner_a_split <= 1),
    joins_locked BOOLEAN NOT NULL DEFAULT FALSE,
    partner_a_joint_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    partner_b_joint_transfer NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    partner_a_joint_optional NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    partner_b_joint_optional NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    expense_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
    income_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'profiles_active_household_fk'
    ) THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_active_household_fk
            FOREIGN KEY (active_household_id) REFERENCES public.households(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.household_members (
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    partner_slot TEXT NOT NULL DEFAULT 'a' CHECK (partner_slot IN ('a', 'b')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (household_id, user_id)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'household_members_profile_fk'
    ) THEN
        ALTER TABLE public.household_members
            ADD CONSTRAINT household_members_profile_fk
            FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.budget_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('joint', 'partner_a', 'partner_b')),
    section TEXT NOT NULL CHECK (
        section IN (
            'income',
            'regular_expense',
            'budgeted_expense',
            'prepayment',
            'debt',
            'personal_bill',
            'savings',
            'personal_budgeted'
        )
    ),
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Others/Irregular',
    amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    partner_a_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    partner_b_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    actual_amount NUMERIC(12, 2),
    raw_cost NUMERIC(12, 2),
    frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (
        frequency IN ('monthly', 'bi_monthly', 'quarterly', 'six_monthly', 'annually', 'four_weekly', 'weekly')
    ),
    custom_split_a NUMERIC(6, 4),
    paid_by TEXT NOT NULL DEFAULT '',
    is_paid BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.spend_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    budget_item_id UUID REFERENCES public.budget_items(id) ON DELETE SET NULL,
    pot_name TEXT NOT NULL,
    month_key TEXT NOT NULL,
    spend_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(12, 2) NOT NULL,
    paid_by TEXT NOT NULL DEFAULT 'joint',
    note TEXT NOT NULL DEFAULT '',
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.monthly_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
    month_key TEXT NOT NULL,
    label TEXT NOT NULL,
    pot_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (household_id, month_key)
);

-- 2. Indexes for RLS & Query Performance
CREATE INDEX IF NOT EXISTS idx_profiles_active_household ON public.profiles(active_household_id);
CREATE INDEX IF NOT EXISTS idx_households_created_by ON public.households(created_by);
CREATE INDEX IF NOT EXISTS idx_household_members_user_id ON public.household_members(user_id);
CREATE INDEX IF NOT EXISTS idx_budget_items_household_scope ON public.budget_items(household_id, scope, section, sort_order);
CREATE INDEX IF NOT EXISTS idx_spend_logs_household_month ON public.spend_logs(household_id, month_key, spend_date DESC);
CREATE INDEX IF NOT EXISTS idx_spend_logs_budget_item ON public.spend_logs(budget_item_id);
CREATE INDEX IF NOT EXISTS idx_monthly_snapshots_household ON public.monthly_snapshots(household_id, month_key);

-- 3. Private Helper & Trigger Functions
CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.autoconfirm_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    NEW.email_confirmed_at := COALESCE(NEW.email_confirmed_at, NOW());
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
    v_base TEXT;
    v_username TEXT;
    v_display TEXT;
    v_contact TEXT;
    v_color TEXT;
BEGIN
    v_base := lower(
        regexp_replace(
            COALESCE(
                NULLIF(trim(v_meta ->> 'username'), ''),
                NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
                'user_' || left(replace(NEW.id::text, '-', ''), 8)
            ),
            '[^a-zA-Z0-9_-]+',
            '',
            'g'
        )
    );
    IF v_base = '' THEN
        v_base := 'user_' || left(replace(NEW.id::text, '-', ''), 8);
    END IF;

    v_username := v_base;
    IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.username = v_username) THEN
        v_username := v_base || '_' || left(replace(NEW.id::text, '-', ''), 4);
    END IF;

    v_display := COALESCE(
        NULLIF(trim(v_meta ->> 'display_name'), ''),
        NULLIF(trim(v_meta ->> 'username'), ''),
        v_username
    );

    v_contact := COALESCE(
        NULLIF(trim(v_meta ->> 'contact_email'), ''),
        CASE
            WHEN COALESCE(NEW.email, '') LIKE '%@users.reste.app' THEN ''
            ELSE COALESCE(NEW.email, '')
        END
    );

    v_color := COALESCE(NULLIF(trim(v_meta ->> 'avatar_color'), ''), '#1b6b5a');

    INSERT INTO public.profiles (id, username, display_name, email, avatar_color)
    VALUES (NEW.id, v_username, v_display, v_contact, v_color)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.is_household_member(p_household_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.household_members hm
        WHERE hm.household_id = p_household_id
          AND hm.user_id = (SELECT auth.uid())
    );
$$;

CREATE OR REPLACE FUNCTION private.can_access_budget_scope(p_household_id UUID, p_scope TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT CASE
        WHEN p_scope = 'joint' THEN private.is_household_member(p_household_id)
        WHEN p_scope = 'partner_a' THEN EXISTS (
            SELECT 1 FROM public.household_members hm
            WHERE hm.household_id = p_household_id
              AND hm.user_id = (SELECT auth.uid())
              AND hm.partner_slot = 'a'
        )
        WHEN p_scope = 'partner_b' THEN EXISTS (
            SELECT 1 FROM public.household_members hm
            WHERE hm.household_id = p_household_id
              AND hm.user_id = (SELECT auth.uid())
              AND hm.partner_slot = 'b'
        )
        ELSE FALSE
    END;
$$;

CREATE OR REPLACE FUNCTION private.can_claim_partner_slot(p_household_id UUID, p_user_id UUID, p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT p_user_id = (SELECT auth.uid())
       AND private.is_household_member(p_household_id)
       AND NOT EXISTS (
           SELECT 1 FROM public.household_members hm
           WHERE hm.household_id = p_household_id
             AND hm.partner_slot = p_slot
             AND hm.user_id <> (SELECT auth.uid())
       );
$$;

CREATE OR REPLACE FUNCTION private.generate_invite_code()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
    v_chars CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_code TEXT;
    i INTEGER;
BEGIN
    LOOP
        v_code := '';
        FOR i IN 1..6 LOOP
            v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
        END LOOP;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.households h WHERE h.invite_code = v_code);
    END LOOP;
    RETURN v_code;
END;
$$;

-- Attach Triggers (idempotent via pg_trigger check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profiles_updated_at') THEN
        CREATE TRIGGER trg_profiles_updated_at
            BEFORE UPDATE ON public.profiles
            FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_households_updated_at') THEN
        CREATE TRIGGER trg_households_updated_at
            BEFORE UPDATE ON public.households
            FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_budget_items_updated_at') THEN
        CREATE TRIGGER trg_budget_items_updated_at
            BEFORE UPDATE ON public.budget_items
            FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reste_autoconfirm_auth_user') THEN
        CREATE TRIGGER trg_reste_autoconfirm_auth_user
            BEFORE INSERT ON auth.users
            FOR EACH ROW EXECUTE FUNCTION private.autoconfirm_auth_user();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reste_on_auth_user_created') THEN
        CREATE TRIGGER trg_reste_on_auth_user_created
            AFTER INSERT ON auth.users
            FOR EACH ROW EXECUTE FUNCTION private.handle_new_auth_user();
    END IF;
END $$;

-- 4. Grants & Row-Level Security
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.households TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.household_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budget_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spend_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.monthly_snapshots TO authenticated;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spend_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_snapshots ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
CREATE POLICY "profiles_select_own_or_co_member" ON public.profiles
    FOR SELECT TO authenticated
    USING (
        (SELECT auth.uid()) = id
        OR EXISTS (
            SELECT 1
            FROM public.household_members hm
            WHERE hm.user_id = profiles.id
              AND private.is_household_member(hm.household_id)
        )
    );

CREATE POLICY "profiles_insert_own" ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = id)
    WITH CHECK ((SELECT auth.uid()) = id);

-- Households Policies
CREATE POLICY "households_member_select" ON public.households
    FOR SELECT TO authenticated
    USING (private.is_household_member(id));

CREATE POLICY "households_member_insert" ON public.households
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = created_by);

CREATE POLICY "households_member_update" ON public.households
    FOR UPDATE TO authenticated
    USING (private.is_household_member(id))
    WITH CHECK (private.is_household_member(id));

CREATE POLICY "households_member_delete" ON public.households
    FOR DELETE TO authenticated
    USING (private.is_household_member(id));

-- Household Members Policies
CREATE POLICY "household_members_select" ON public.household_members
    FOR SELECT TO authenticated
    USING (private.is_household_member(household_id));

CREATE POLICY "household_members_insert_self" ON public.household_members
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT auth.uid()) = user_id AND private.is_household_member(household_id));

CREATE POLICY "household_members_update_member" ON public.household_members
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = user_id AND private.is_household_member(household_id))
    WITH CHECK (private.can_claim_partner_slot(household_id, user_id, partner_slot));

CREATE POLICY "household_members_delete_self_or_member" ON public.household_members
    FOR DELETE TO authenticated
    USING (private.is_household_member(household_id));

-- Budget Items Policies
CREATE POLICY "budget_items_member_select" ON public.budget_items
    FOR SELECT TO authenticated
    USING (private.can_access_budget_scope(household_id, scope));

CREATE POLICY "budget_items_member_insert" ON public.budget_items
    FOR INSERT TO authenticated
    WITH CHECK (private.can_access_budget_scope(household_id, scope));

CREATE POLICY "budget_items_member_update" ON public.budget_items
    FOR UPDATE TO authenticated
    USING (private.can_access_budget_scope(household_id, scope))
    WITH CHECK (private.can_access_budget_scope(household_id, scope));

CREATE POLICY "budget_items_member_delete" ON public.budget_items
    FOR DELETE TO authenticated
    USING (private.can_access_budget_scope(household_id, scope));

-- Spend Logs Policies
CREATE POLICY "spend_logs_member_select" ON public.spend_logs
    FOR SELECT TO authenticated
    USING (private.is_household_member(household_id));

CREATE POLICY "spend_logs_member_insert" ON public.spend_logs
    FOR INSERT TO authenticated
    WITH CHECK (private.is_household_member(household_id));

CREATE POLICY "spend_logs_member_update" ON public.spend_logs
    FOR UPDATE TO authenticated
    USING (private.is_household_member(household_id))
    WITH CHECK (private.is_household_member(household_id));

CREATE POLICY "spend_logs_member_delete" ON public.spend_logs
    FOR DELETE TO authenticated
    USING (private.is_household_member(household_id));

-- Monthly Snapshots Policies
CREATE POLICY "monthly_snapshots_member_select" ON public.monthly_snapshots
    FOR SELECT TO authenticated
    USING (private.is_household_member(household_id));

CREATE POLICY "monthly_snapshots_member_insert" ON public.monthly_snapshots
    FOR INSERT TO authenticated
    WITH CHECK (private.is_household_member(household_id));

CREATE POLICY "monthly_snapshots_member_update" ON public.monthly_snapshots
    FOR UPDATE TO authenticated
    USING (private.is_household_member(household_id))
    WITH CHECK (private.is_household_member(household_id));

CREATE POLICY "monthly_snapshots_member_delete" ON public.monthly_snapshots
    FOR DELETE TO authenticated
    USING (private.is_household_member(household_id));

-- 5. Controlled Household RPCs
CREATE OR REPLACE FUNCTION public.create_household_rpc(
    p_name TEXT DEFAULT 'Our Household',
    p_partner_a_name TEXT DEFAULT 'Partner A',
    p_partner_b_name TEXT DEFAULT 'Partner B',
    p_currency TEXT DEFAULT '£',
    p_active_month TEXT DEFAULT 'current',
    p_expense_categories JSONB DEFAULT '[]'::jsonb,
    p_income_categories JSONB DEFAULT '[]'::jsonb
)
RETURNS public.households
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_code TEXT;
    v_household public.households;
    v_display TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT COALESCE(NULLIF(display_name, ''), username, '')
      INTO v_display
      FROM public.profiles
     WHERE id = v_uid;

    v_code := private.generate_invite_code();

    INSERT INTO public.households (
        name,
        invite_code,
        currency,
        active_month,
        partner_a_name,
        partner_b_name,
        expense_categories,
        income_categories,
        created_by,
        updated_by_name
    )
    VALUES (
        COALESCE(NULLIF(trim(p_name), ''), 'Our Household'),
        v_code,
        COALESCE(NULLIF(trim(p_currency), ''), '£'),
        COALESCE(NULLIF(trim(p_active_month), ''), 'current'),
        COALESCE(NULLIF(trim(p_partner_a_name), ''), 'Partner A'),
        COALESCE(NULLIF(trim(p_partner_b_name), ''), 'Partner B'),
        COALESCE(p_expense_categories, '[]'::jsonb),
        COALESCE(p_income_categories, '[]'::jsonb),
        v_uid,
        COALESCE(v_display, '')
    )
    RETURNING * INTO v_household;

    INSERT INTO public.household_members (household_id, user_id, role, partner_slot)
    VALUES (v_household.id, v_uid, 'owner', 'a')
    ON CONFLICT (household_id, user_id) DO NOTHING;

    UPDATE public.profiles
       SET active_household_id = v_household.id
     WHERE id = v_uid;

    RETURN v_household;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_household_rpc(
    p_invite_code TEXT,
    p_partner_slot TEXT DEFAULT NULL
)
RETURNS public.households
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_clean_code TEXT;
    v_household public.households;
    v_slot TEXT;
    v_member_count INTEGER;
    v_role TEXT := 'member';
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    v_clean_code := upper(regexp_replace(COALESCE(p_invite_code, ''), '[^A-Za-z0-9]+', '', 'g'));
    IF length(v_clean_code) < 4 THEN
        RAISE EXCEPTION 'Please enter a valid household share code';
    END IF;

    SELECT * INTO v_household
      FROM public.households h
     WHERE h.invite_code = v_clean_code;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No household found with share code %', v_clean_code;
    END IF;

    IF v_household.joins_locked AND NOT EXISTS (
        SELECT 1 FROM public.household_members hm
        WHERE hm.household_id = v_household.id AND hm.user_id = v_uid
    ) THEN
        RAISE EXCEPTION 'This household has locked new joins. Ask a member to unlock invites in Household settings.';
    END IF;

    SELECT count(*) INTO v_member_count
      FROM public.household_members hm
     WHERE hm.household_id = v_household.id;

    IF v_member_count = 0 THEN
        v_role := 'owner';
        UPDATE public.households
           SET created_by = COALESCE(created_by, v_uid)
         WHERE id = v_household.id;
    END IF;

    IF p_partner_slot IN ('a', 'b') THEN
        v_slot := p_partner_slot;
    ELSIF EXISTS (
        SELECT 1 FROM public.household_members hm
        WHERE hm.household_id = v_household.id AND hm.partner_slot = 'a' AND hm.user_id <> v_uid
    ) THEN
        v_slot := 'b';
    ELSE
        v_slot := 'a';
    END IF;

    INSERT INTO public.household_members (household_id, user_id, role, partner_slot)
    VALUES (v_household.id, v_uid, v_role, v_slot)
    ON CONFLICT (household_id, user_id)
    DO UPDATE SET partner_slot = COALESCE(EXCLUDED.partner_slot, household_members.partner_slot);

    UPDATE public.profiles
       SET active_household_id = v_household.id
     WHERE id = v_uid;

    RETURN v_household;
END;
$$;

CREATE OR REPLACE FUNCTION public.regenerate_invite_code_rpc(p_household_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_code TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    IF NOT private.is_household_member(p_household_id) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    v_code := private.generate_invite_code();
    UPDATE public.households
       SET invite_code = v_code
     WHERE id = p_household_id;

    RETURN v_code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_household_rpc(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_household_rpc(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_invite_code_rpc(UUID) TO authenticated;

-- 6. Realtime Publication & Replica Identity
ALTER TABLE public.households REPLICA IDENTITY FULL;
ALTER TABLE public.household_members REPLICA IDENTITY FULL;
ALTER TABLE public.budget_items REPLICA IDENTITY FULL;
ALTER TABLE public.spend_logs REPLICA IDENTITY FULL;
ALTER TABLE public.monthly_snapshots REPLICA IDENTITY FULL;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['households', 'household_members', 'budget_items', 'spend_logs', 'monthly_snapshots']
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = t
        ) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        END IF;
    END LOOP;
END $$;
