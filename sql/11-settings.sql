-- ════════════════════════════════════════════════════════════════════════════
-- 11 · App settings — what the research depth levels actually mean
--
-- The three levels are a fixed vocabulary (quick / standard / deep) but the
-- numbers behind them are not: what counts as "quick" depends on the topics an
-- agency writes about and what it is willing to spend. Those numbers belong to
-- whoever pays the bill, which is the admin, not the codebase.
--
-- One row, enforced by a primary key that can only ever be true. A settings
-- table that can grow a second row is a settings table that will, and then
-- every read needs to decide which one is real.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists app_settings (
  id                    boolean primary key default true check (id),
  -- Overrides, merged over the built-in defaults in lib/research-depth.ts.
  -- Sparse on purpose: a level nobody has touched stays on whatever the code
  -- ships, rather than being frozen at whatever it was the day this row was
  -- written.
  research_profiles     jsonb not null default '{}',
  -- What a new request gets when nobody chooses.
  default_research_depth text not null default 'standard',
  updated_at            timestamptz not null default now(),
  updated_by            uuid references app_users(id),
  constraint app_settings_default_depth
    check (default_research_depth in ('quick', 'standard', 'deep'))
);

insert into app_settings (id) values (true) on conflict (id) do nothing;

alter table app_settings enable row level security;
