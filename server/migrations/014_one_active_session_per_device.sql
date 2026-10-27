WITH ranked_active_sessions AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY device_identity
      ORDER BY created_at DESC, id DESC
    ) AS session_rank
  FROM user_sessions
  WHERE revoked_at IS NULL
    AND device_identity IS NOT NULL
)
UPDATE user_sessions AS sessions
SET revoked_at = NOW()
FROM ranked_active_sessions AS ranked
WHERE sessions.id = ranked.id
  AND ranked.session_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_one_active_per_device
  ON user_sessions (device_identity)
  WHERE revoked_at IS NULL
    AND device_identity IS NOT NULL;
