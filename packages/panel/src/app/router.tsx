import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { EventsPage } from '../admin/EventsPage.tsx';
import { LogsPage } from '../admin/LogsPage.tsx';
import { PluginsPage } from '../admin/PluginsPage.tsx';
import { DashboardPage } from '../dashboard/DashboardPage.tsx';
import { OverlaysPage } from '../overlays/OverlaysPage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { PluginPage } from '../plugins/PluginPage.tsx';
import { SettingsPage } from '../settings/SettingsPage.tsx';
import { Shell } from '../shell/Shell.tsx';

export const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFoundPage });

const pluginPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$pluginId/$',
  component: PluginPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$pluginId',
  component: SettingsPage,
});

const adminPluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/plugins',
  component: PluginsPage,
});

const adminOverlaysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/overlays',
  component: OverlaysPage,
});

const adminOverlayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/overlays/$instanceId',
  component: OverlaysPage,
});

const adminLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/logs',
  component: LogsPage,
});

const adminEventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/events',
  component: EventsPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

export const routeTree = rootRoute.addChildren([
  dashboardRoute,
  pluginPageRoute,
  settingsRoute,
  adminPluginsRoute,
  adminOverlaysRoute,
  adminOverlayRoute,
  adminLogsRoute,
  adminEventsRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
