-- Optional pre-deploy migration. The pickup endpoint also creates this table
-- defensively so deployments remain backwards compatible.
CREATE TABLE IF NOT EXISTS job_pickup_proofs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  transporter_id uuid NOT NULL REFERENCES users(id),
  photo_url text NOT NULL,
  latitude double precision,
  longitude double precision,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_pickup_proofs_transporter
  ON job_pickup_proofs (transporter_id);
