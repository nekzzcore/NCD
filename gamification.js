/**
 * NCD — Gamification System (RPG Engine)
 * Математика прогрессии, HP, уровни, наказания, награды
 */

const GameMath = {
    // ──────────────────────────────────────────────
    // XP & LEVELS
    // ──────────────────────────────────────────────
    /** XP для следующего уровня: 100 * (level ^ 1.5) */
    xpForLevel(level) {
        return Math.floor(100 * Math.pow(level, 1.5));
    },

    /** Текущий прогресс к следующему уровню (0-100) */
    xpProgress(xp, level) {
        const currentLevelXp = this.xpForLevel(level);
        const nextLevelXp = this.xpForLevel(level + 1);
        const progress = ((xp - currentLevelXp) / (nextLevelXp - currentLevelXp)) * 100;
        return Math.max(0, Math.min(100, Math.floor(progress)));
    },

    /** Вычислить уровень по общему XP */
    levelFromXp(totalXp) {
        let level = 1;
        while (totalXp >= this.xpForLevel(level + 1)) {
            level++;
        }
        return level;
    },

    /** XP для конкретного действия */
    xpRewards: {
        habit: { easy: 25, medium: 50, hard: 100 },
        goalComplete: 500,
        subgoal: 5,
        achievement: 20,
        newGoal: 10,
    },

    /** XP для следующего уровня: 100 * (level ^ 1.5) */
    // ──────────────────────────────────────────────
    /** Бонус к XP от стрика: +10% каждые 5 дней, макс +50% */
    streakMultiplier(streak) {
        const bonus = Math.floor(streak / 5) * 0.1;
        return Math.min(bonus, 0.5);
    },

    /** Применить множитель стрика к базовому XP */
    applyStreakBonus(baseXp, streak) {
        return Math.floor(baseXp * (1 + this.streakMultiplier(streak)));
    },

    // ──────────────────────────────────────────────
    // HP SYSTEM
    // ──────────────────────────────────────────────
    maxHp: 100,
    deathThreshold: 0,

    /** Штрафы за пропуск привычки */
    missPenalty: {
        hp: -15,
        xpPercent: 0.05, // 5% от текущего уровня
    },

    /** Состояние смерти (HP <= 0) */
    deathPenalty: {
        levelDown: 1,
        streakReset: true,
        hpRestore: 50,
        debuff: { id: 'injury', name: 'Травма', durationHours: 24, xpReduction: 0.2 },
    },

    // ──────────────────────────────────────────────
    // BADGES / ACHIEVEMENTS
    // ──────────────────────────────────────────────
    badgeDefinitions: [
        { id: 'first', name: 'Первый шаг', description: 'Заверши первую цель', icon: '🥇', condition: (g) => g.completedGoals >= 1 },
        { id: 'five', name: 'На верном пути', description: 'Заверши 5 целей', icon: '🏆', condition: (g) => g.completedGoals >= 5 },
        { id: 'ten', name: 'Мастер целей', description: 'Заверши 10 целей', icon: '🎯', condition: (g) => g.completedGoals >= 10 },
        { id: 'twenty', name: 'Достигатор', description: 'Заверши 20 целей', icon: '🏅', condition: (g) => g.completedGoals >= 20 },
        { id: 'fifty', name: 'Легенда', description: 'Заверши 50 целей', icon: '👑', condition: (g) => g.completedGoals >= 50 },
        { id: 'week', name: 'Неделя огня', description: 'Стрик 7 дней', icon: '🔥', condition: (g) => g.streak >= 7 },
        { id: 'month', name: 'Железная воля', description: 'Стрик 30 дней', icon: '💎', condition: (g) => g.streak >= 30 },
        { id: 'hundred_days', name: 'Стоицист', description: 'Стрик 100 дней', icon: '🗿', condition: (g) => g.streak >= 100 },
        { id: 'level_5', name: 'Рядовой', description: 'Достигни 5 уровня', icon: '⭐', condition: (g) => g.level >= 5 },
        { id: 'level_10', name: 'Офицер', description: 'Достигни 10 уровня', icon: '⭐⭐', condition: (g) => g.level >= 10 },
        { id: 'level_20', name: 'Командир', description: 'Достигни 20 уровня', icon: '⭐⭐⭐', condition: (g) => g.level >= 20 },
        { id: 'level_50', name: 'Генерал', description: 'Достигни 50 уровня', icon: '🌟', condition: (g) => g.level >= 50 },
        { id: 'first_habit', name: 'Начинающий', description: 'Создай первую привычку', icon: '🌱', condition: (g) => g.totalHabits >= 1 },
        { id: 'habit_master', name: 'Мастер привычек', description: '10 активных привычек', icon: '📅', condition: (g) => g.activeHabits >= 10 },
        { id: 'early_bird', name: 'Жаворонок', description: 'Выполни привычку до 8 утра', icon: '🌅', condition: (g) => g.earlyCompletions >= 1 },
        { id: 'night_owl', name: 'Сова', description: 'Выполни привычку после 23:00', icon: '🦉', condition: (g) => g.lateCompletions >= 1 },
    ],
};

/**
 * Основной класс системы геймификации
 */
class GamificationEngine {
    constructor(app) {
        this.app = app;
        this.state = app.gamification || this.getDefaultState();
        this.app.gamification = this.state; // ссылка для совместимости
        this.activeDebuffs = new Map(); // id -> { expiresAt, data }
        this.loadDebuffs();
    }

    getDefaultState() {
        return {
            xp: 0,
            level: 1,
            hp: 100,
            maxHp: 100,
            streak: 0,
            lastActiveDate: null,
            badges: [],
            completedGoals: 0,
            totalHabits: 0,
            activeHabits: 0,
            earlyCompletions: 0,
            lateCompletions: 0,
            skipProtectionPotions: 0, // купленные зелья защиты
            injuryDebuffUntil: null, // timestamp до которого действует дебафф
            lastMissedCheck: null, // date string of last missed habit check
        };
    }

    // ──────────────────────────────────────────────
    // PERSISTENCE
    // ──────────────────────────────────────────────
    save() {
        this.app.saveData();
    }

    loadDebuffs() {
        if (this.state.injuryDebuffUntil && this.state.injuryDebuffUntil > Date.now()) {
            this.activeDebuffs.set('injury', {
                expiresAt: this.state.injuryDebuffUntil,
                data: GameMath.deathPenalty.debuff,
            });
        } else if (this.state.injuryDebuffUntil) {
            // просрочено — чистим
            this.state.injuryDebuffUntil = null;
        }
    }

    // ──────────────────────────────────────────────
    // XP & LEVELS
    // ──────────────────────────────────────────────
    addXp(baseAmount, source = '', habitDifficulty = null) {
        if (!this.app.settings.gamification) return 0;

        let amount = baseAmount;
        // Применяем бонус стрика
        if (habitDifficulty && GameMath.xpRewards.habit[habitDifficulty]) {
            amount = GameMath.xpRewards.habit[habitDifficulty];
        }
        amount = GameMath.applyStreakBonus(amount, this.state.streak);

        // Применяем дебафф травмы (-20% XP)
        if (this.hasActiveDebuff('injury')) {
            amount = Math.floor(amount * (1 - GameMath.deathPenalty.debuff.xpReduction));
        }

        const oldLevel = this.state.level;
        this.state.xp += amount;
        this.state.level = GameMath.levelFromXp(this.state.xp);

        // Level Up!
        if (this.state.level > oldLevel) {
            this.onLevelUp(oldLevel, this.state.level);
        }

        this.save();
        return amount;
    }

    onLevelUp(oldLevel, newLevel) {
        this.app.showToast(`🎉 Новый уровень: ${newLevel}!`, 'success');
        this.app.triggerConfetti?.();
        this.app.playSound?.('levelup');
        this.checkBadges();
    }

    // ──────────────────────────────────────────────
    // ──────────────────────────────────────────────


    // ──────────────────────────────────────────────
    // HP & PENALTIES
    // ──────────────────────────────────────────────
    /** Пропуск привычки — основной метод наказания */
    applyMissPenalty(habitId = null) {
        if (!this.app.settings.gamification) return { applied: false, reason: 'gamification_disabled' };

        // Проверяем, есть ли зелье защиты
        if (this.state.skipProtectionPotions > 0) {
            this.state.skipProtectionPotions--;
            this.app.showToast('🛡️ Зелье защиты сработало! Штрафы отменены.', 'success');
            this.save();
            return { applied: false, reason: 'protected', potionsLeft: this.state.skipProtectionPotions };
        }

        const penalty = GameMath.missPenalty;

        // HP
        this.state.hp = Math.max(0, this.state.hp + penalty.hp);

      

        // XP: -5% от XP текущего уровня
        const currentLevelXp = GameMath.xpForLevel(this.state.level);
        const xpLoss = Math.floor(currentLevelXp * penalty.xpPercent);
        this.state.xp = Math.max(currentLevelXp, this.state.xp - xpLoss);

        // Проверка смерти
        let died = false;
        if (this.state.hp <= GameMath.deathThreshold) {
            died = this.applyDeathPenalty();
        }

        this.save();

    }

    /** Смерть / Истощение (HP <= 0) */
    applyDeathPenalty() {
        const penalty = GameMath.deathPenalty;

        // Потеря уровня
        this.state.level = Math.max(1, this.state.level - penalty.levelDown);
        // XP ставим на минимум для нового уровня
        this.state.xp = GameMath.xpForLevel(this.state.level);

        // Сброс стрика
        this.state.streak = 0;
        this.state.lastActiveDate = null;

        // Восстановление HP
        this.state.hp = penalty.hpRestore;

        // Наложение дебаффа "Травма" на 24 часа
        const expiresAt = Date.now() + penalty.debuff.durationHours * 60 * 60 * 1000;
        this.state.injuryDebuffUntil = expiresAt;
        this.activeDebuffs.set('injury', { expiresAt, data: penalty.debuff });

        this.app.showDamageModal?.({
            died: true,
            message: `☠️ Персонаж погиб! Уровень снижен до ${this.state.level}. Наложена "Травма" на 24ч (-20% XP).`,
        });

        return true;
    }

    /** Восстановление HP (например, за выполнение привычки или покупку) */
    healHp(amount) {
        this.state.hp = Math.min(this.state.maxHp, this.state.hp + amount);
        this.save();
    }

    /** Полное восстановление HP (например, за уровень) */
    fullHeal() {
        this.state.hp = this.state.maxHp;
        this.save();
    }

    hasActiveDebuff(id) {
        const debuff = this.activeDebuffs.get(id);
        if (!debuff) return false;
        if (Date.now() > debuff.expiresAt) {
            this.activeDebuffs.delete(id);
            if (id === 'injury') this.state.injuryDebuffUntil = null;
            this.save();
            return false;
        }
        return true;
    }

    getActiveDebuffs() {
        const now = Date.now();
        const result = [];
        for (const [id, debuff] of this.activeDebuffs) {
            if (now <= debuff.expiresAt) {
                result.push({ id, ...debuff.data, remainingMs: debuff.expiresAt - now });
            }
        }
        return result;
    }

    // ──────────────────────────────────────────────
    // STREAK
    // ──────────────────────────────────────────────
    updateStreak() {
        const today = new Date().toISOString().split('T')[0];
        const last = this.state.lastActiveDate;
        if (last === today) return; // уже считалось сегодня

        const yest = new Date();
        yest.setDate(yest.getDate() - 1);
        const yestStr = yest.toISOString().split('T')[0];

        if (last === yestStr) {
            this.state.streak++;
        } else {
            this.state.streak = 1;
        }
        this.state.lastActiveDate = today;
        this.checkBadges();
        this.save();
    }

    // ──────────────────────────────────────────────
    // HABITS INTEGRATION
    // ──────────────────────────────────────────────
    onHabitComplete(habit) {
        // habit: { difficulty: 'easy'|'medium'|'hard', completedAt: Date }
        this.updateStreak();
        const xpGained = this.addXp(0, 'habit', habit.difficulty);
        // XP gained already calculated above

        if (itemId === 'skip_protection') {
            this.state.skipProtectionPotions++;
        } else if (itemId === 'heal_small') {
            this.state.hp = Math.min(this.state.maxHp, this.state.hp + 30);
        } else if (itemId === 'heal_full') {
            this.state.hp = this.state.maxHp;
        } else if (itemId === 'rest_day') {
            this.state.hp = Math.min(this.state.maxHp, this.state.hp + 20);
        }

        this.save();
        this.app.showToast?.(`✅ Куплено: ${item.name}`, 'success');
        return { success: true, item };
    }



    // ──────────────────────────────────────────────
    // UI HELPERS (for widgets)
    // ──────────────────────────────────────────────
    getHpPercent() {
        return Math.max(0, Math.min(100, (this.state.hp / this.state.maxHp) * 100));
    }

    getXpPercent() {
        return GameMath.xpProgress(this.state.xp, this.state.level);
    }

    getXpToNextLevel() {
        return GameMath.xpForLevel(this.state.level + 1) - this.state.xp;
    }

    getStreakMultiplierPercent() {
        return Math.floor(GameMath.streakMultiplier(this.state.streak) * 100);
    }

    getStateForWidget() {
        return {
            level: this.state.level,
            xp: this.state.xp,
            xpPercent: this.getXpPercent(),
            xpToNext: this.getXpToNextLevel(),
            hp: this.state.hp,
            hpPercent: this.getHpPercent(),
            streak: this.state.streak,
            streakMultiplier: this.getStreakMultiplierPercent(),
            badgesCount: this.state.badges.length,
            debuffs: this.getActiveDebuffs(),
        };
    }
}

// ──────────────────────────────────────────────────
// AUTO-INIT (классический <script>, без модулей)
// ──────────────────────────────────────────────────
if (typeof window !== 'undefined') {
    window.GameMath = GameMath;
    window.GamificationEngine = GamificationEngine;
}