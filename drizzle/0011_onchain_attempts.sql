ALTER TABLE resources ADD COLUMN onchain_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN delivery_status text NOT NULL DEFAULT 'delivered';