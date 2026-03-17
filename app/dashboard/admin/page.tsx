/**
 * Admin Dashboard
 *
 * Features: user management, observability graphs, plugin marketplace,
 * security controls, scaling knobs.
 */

export default function AdminDashboardPage() {
  return (
    <div className="p-6 lg:p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="text-muted-foreground">Platform management and monitoring</p>
      </header>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {/* Stats Cards */}
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">Total Users</p>
          <p className="mt-2 text-3xl font-bold">0</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">Active Courses</p>
          <p className="mt-2 text-3xl font-bold">0</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">Agent Calls (24h)</p>
          <p className="mt-2 text-3xl font-bold">0</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">System Health</p>
          <p className="mt-2 text-3xl font-bold text-green-500">OK</p>
        </div>

        {/* User Management */}
        <div className="col-span-full rounded-xl border border-border bg-card p-6 lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold">User Management</h2>
          <p className="text-sm text-muted-foreground">
            User registration and role management will be available when authentication is
            configured.
          </p>
        </div>

        {/* System Monitoring */}
        <div className="col-span-full rounded-xl border border-border bg-card p-6 lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold">System Monitoring</h2>
          <p className="text-sm text-muted-foreground">
            Enable OpenTelemetry in your environment to see system metrics and traces.
          </p>
        </div>

        {/* Plugin Marketplace */}
        <div className="col-span-full rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-semibold">Plugin Marketplace</h2>
          <p className="text-sm text-muted-foreground">
            The plugin marketplace will be available in a future release. Plugins will allow
            extending the platform with custom agents, scene types, and widgets.
          </p>
        </div>
      </div>
    </div>
  );
}
