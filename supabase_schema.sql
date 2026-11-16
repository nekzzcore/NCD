-- ============================================================
-- GoalTracker Pro — Supabase Schema (PostgreSQL)
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. PROFILES TABLE (extends auth.users)
-- ============================================================
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    level INT DEFAULT 1,
    xp INT DEFAULT 0,
    hp INT DEFAULT 100,
    gold INT DEFAULT 0,
    streak INT DEFAULT 0,
    avatar_url TEXT,
    nickname TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
    ON public.profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, nickname)
    VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'nickname', 'Player'));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 2. HABITS TABLE
-- ============================================================
CREATE TABLE public.habits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    frequency TEXT DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    time_reminder TIME,
    color TEXT DEFAULT '#6366f1',
    completed_days DATE[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.habits ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can manage own habits"
    ON public.habits FOR ALL
    USING (auth.uid() = user_id);

CREATE TRIGGER set_habits_updated_at
    BEFORE UPDATE ON public.habits
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Index for faster queries
CREATE INDEX idx_habits_user_id ON public.habits(user_id);


-- ============================================================
-- 3. GOALS TABLE
-- ============================================================
CREATE TABLE public.goals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'personal' CHECK (category IN ('personal', 'career', 'health', 'finance', 'education', 'hobby', 'other')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical', 'milestone')),
    target_amount NUMERIC DEFAULT 0,
    current_amount NUMERIC DEFAULT 0,
    deadline DATE,
    is_completed BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
    parent_id UUID REFERENCES public.goals(id) ON DELETE SET NULL,
    tags TEXT[] DEFAULT '{}',
    subgoals JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can manage own goals"
    ON public.goals FOR ALL
    USING (auth.uid() = user_id);

CREATE TRIGGER set_goals_updated_at
    BEFORE UPDATE ON public.goals
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Index
CREATE INDEX idx_goals_user_id ON public.goals(user_id);
CREATE INDEX idx_goals_parent_id ON public.goals(parent_id);


-- ============================================================
-- 4. ACHIEVEMENTS TABLE
-- ============================================================
CREATE TABLE public.achievements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    goal_id UUID REFERENCES public.goals(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    date DATE NOT NULL,
    progress INT DEFAULT 0,
    protected BOOLEAN DEFAULT FALSE,
    auto_created BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own achievements"
    ON public.achievements FOR ALL
    USING (auth.uid() = user_id);

CREATE TRIGGER set_achievements_updated_at
    BEFORE UPDATE ON public.achievements
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_achievements_user_id ON public.achievements(user_id);
CREATE INDEX idx_achievements_goal_id ON public.achievements(goal_id);


-- ============================================================
-- 5. NOTES/EVENTS TABLE (Calendar)
-- ============================================================
CREATE TABLE public.notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    content TEXT NOT NULL,
    time TIME,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own notes"
    ON public.notes FOR ALL
    USING (auth.uid() = user_id);

CREATE TRIGGER set_notes_updated_at
    BEFORE UPDATE ON public.notes
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_notes_user_id ON public.notes(user_id);
CREATE INDEX idx_notes_date ON public.notes(user_id, date);


-- ============================================================
-- 6. SETTINGS TABLE
-- ============================================================
CREATE TABLE public.user_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    theme TEXT DEFAULT 'dark' CHECK (theme IN ('light', 'dark', 'auto')),
    notifications BOOLEAN DEFAULT TRUE,
    reminder_days INT DEFAULT 3,
    gamification BOOLEAN DEFAULT TRUE,
    auto_sync BOOLEAN DEFAULT TRUE,
    sync_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own settings"
    ON public.user_settings FOR ALL
    USING (auth.uid() = user_id);

CREATE TRIGGER set_user_settings_updated_at
    BEFORE UPDATE ON public.user_settings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 7. GAMIFICATION / BADGES TABLE
-- ============================================================
CREATE TABLE public.badges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    badge_id TEXT NOT NULL, -- e.g., 'first', 'five', 'ten', 'week', 'level_up'
    title TEXT NOT NULL,
    description TEXT,
    earned_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, badge_id)
);

ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own badges"
    ON public.badges FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own badges"
    ON public.badges FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_badges_user_id ON public.badges(user_id);


-- ============================================================
-- 8. SYNC METADATA TABLE (for conflict resolution)
-- ============================================================
CREATE TABLE public.sync_metadata (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    last_sync_at TIMESTAMPTZ DEFAULT NOW(),
    client_version TEXT,
    device_id TEXT,
    data_hash TEXT -- for quick change detection
);

ALTER TABLE public.sync_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own sync metadata"
    ON public.sync_metadata FOR ALL
    USING (auth.uid() = user_id);


-- ============================================================
-- HELPER VIEWS
-- ============================================================

-- User dashboard summary
CREATE VIEW public.user_dashboard AS
SELECT 
    p.id,
    p.nickname,
    p.avatar_url,
    p.level,
    p.xp,
    p.gold,
    p.streak,
    (SELECT COUNT(*) FROM public.goals WHERE user_id = p.id AND status = 'active') AS active_goals,
    (SELECT COUNT(*) FROM public.goals WHERE user_id = p.id AND status = 'completed') AS completed_goals,
    (SELECT COUNT(*) FROM public.habits WHERE user_id = p.id) AS total_habits,
    (SELECT COUNT(*) FROM public.achievements WHERE user_id = p.id) AS total_achievements
FROM public.profiles p
WHERE p.id = auth.uid();