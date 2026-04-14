# Skill: Handling Supabase Migrations

## Context
The project uses a local-first Supabase migration workflow. All schema changes must be tracked via SQL files in `supabase/migrations`.

## Instructions for AI Agents

### 1. Creating New Migrations
When asked to add a table or modify the schema:
1. **Prefer CLI**: If you have terminal access, run `supabase migration new <name>`.
2. **Naming**: If creating manually, use the format `YYYYMMDDHHMMSS_description.sql`.
3. **Idempotence**: 
    - Use `CREATE TABLE IF NOT EXISTS`.
    - Use `CREATE INDEX IF NOT EXISTS`.
    - Use `DROP POLICY IF EXISTS` before `CREATE POLICY`.
    - Wrap complex logic in `DO $$ BEGIN ... END $$;`.

### 2. Consistency
- Always check `supabase/migrations` for existing tables before creating new ones to avoid conflicts.
- Ensure RLS is enabled for every new table: `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;`.

### 3. Workflow
- **Do not** assume the production database is in sync with the local migrations.
- **Do not** suggest running `supabase db push` to production unless explicitly directed by the user after local verification.
- Encourage the user to run `supabase db reset` locally to test new migrations.

## Reference
See [docs/database-migrations.md](file:///Users/thunderbolt/Documents/projects/Slate-code/Slate/docs/database-migrations.md) for full workflow details.
