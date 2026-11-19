-- Lets an account be admin without setting ADMIN_EMAIL in Cloudflare.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
