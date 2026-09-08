export const ACTION_TYPES = {
    CLICK: 'click',
    TYPE: 'type',
    SCROLL: 'scroll',
    WAIT: 'wait',
    ASK_USER_CONFIRMATION: 'ask_user_confirmation',
    TASK_COMPLETE: 'task_complete',
    TASK_FAILED: 'task_failed'
};

export const RISK_TIERS = {
    SAFE: 'safe',
    RISKY: 'risky'
};

export const RETRY_CONFIG = {
    MAX_STEPS: 20,
    MAX_RETRIES_PER_STEP: 3,
    STEP_TIMEOUT_MS: 20000,
    POST_ACTION_DELAY_MS: 800
};
