import { lazy } from "react";
import {
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";

/* ---------- Lazy-loaded route components ---------- */

const ProxiesPage = lazy(() => import("@/routes/proxies/index"));
const ProxyNewPage = lazy(() => import("@/routes/proxies/new"));
const ProxyDetailPage = lazy(() => import("@/routes/proxies/$proxyId"));

const ConsumersPage = lazy(() => import("@/routes/consumers/index"));
const ConsumerNewPage = lazy(() => import("@/routes/consumers/new"));
const ConsumerDetailPage = lazy(() => import("@/routes/consumers/$consumerId"));

const PluginsPage = lazy(() => import("@/routes/plugins/index"));
const PluginNewPage = lazy(() => import("@/routes/plugins/new"));
const PluginDetailPage = lazy(() => import("@/routes/plugins/$pluginId"));

const UpstreamsPage = lazy(() => import("@/routes/upstreams/index"));
const UpstreamNewPage = lazy(() => import("@/routes/upstreams/new"));
const UpstreamDetailPage = lazy(() => import("@/routes/upstreams/$upstreamId"));

const MetricsPage = lazy(() => import("@/routes/metrics/index"));
const StatusPage = lazy(() => import("@/routes/status/index"));

const DashboardPage = lazy(() => import("@/routes/dashboard/index"));
const SettingsPage = lazy(() => import("@/routes/settings/index"));

/* ---------- Root route ---------- */

const rootRoute = createRootRoute({
  component: AppShell,
});

/* ---------- Dashboard ---------- */

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

/* ---------- Proxies ---------- */

const proxiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/proxies",
  component: ProxiesPage,
});

const proxyNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/proxies/new",
  component: ProxyNewPage,
});

const proxyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/proxies/$proxyId",
  component: ProxyDetailPage,
});

/* ---------- Consumers ---------- */

const consumersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/consumers",
  component: ConsumersPage,
});

const consumerNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/consumers/new",
  component: ConsumerNewPage,
});

const consumerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/consumers/$consumerId",
  component: ConsumerDetailPage,
});

/* ---------- Plugins ---------- */

const pluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins",
  component: PluginsPage,
});

const pluginNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins/new",
  component: PluginNewPage,
});

const pluginDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins/$pluginId",
  component: PluginDetailPage,
});

/* ---------- Upstreams ---------- */

const upstreamsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upstreams",
  component: UpstreamsPage,
});

const upstreamNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upstreams/new",
  component: UpstreamNewPage,
});

const upstreamDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upstreams/$upstreamId",
  component: UpstreamDetailPage,
});

/* ---------- Metrics ---------- */

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/metrics",
  component: MetricsPage,
});

/* ---------- Health / Status ---------- */

const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/status",
  component: StatusPage,
});

/* ---------- Settings ---------- */

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

/* ---------- Route tree & router ---------- */

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  proxiesRoute,
  proxyNewRoute,
  proxyDetailRoute,
  consumersRoute,
  consumerNewRoute,
  consumerDetailRoute,
  pluginsRoute,
  pluginNewRoute,
  pluginDetailRoute,
  upstreamsRoute,
  upstreamNewRoute,
  upstreamDetailRoute,
  metricsRoute,
  statusRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

/* ---------- Type registration ---------- */

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
